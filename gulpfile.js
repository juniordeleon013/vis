var fs = require('fs');
var async = require('async');
var gulp = require('gulp');
var gutil = require('gulp-util');
var concat = require('gulp-concat');
var cleanCSS = require('gulp-clean-css');
var rename = require("gulp-rename");
var webpack = require('webpack');
var uglify = require('uglify-js');
var rimraf = require('rimraf');
var argv = require('yargs').argv;
var opn = require('opn');
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var webserver = require('gulp-webserver');
var ejs = require('ejs');
var geminiConfig = require('./test/gemini/gemini.config.js');

var ENTRY = './index.js';
var HEADER = './lib/header.js';
var DIST = './dist';
var VIS_JS = 'vis.js';
var VIS_MAP = 'vis.map';
var VIS_MIN_JS = 'vis.min.js';
var VIS_CSS = 'vis.css';
var VIS_MIN_CSS = 'vis.min.css';
var INDIVIDUAL_JS_BUNDLES = [{
  entry: './index-timeline-graph2d.js',
  filename: 'vis-timeline-graph2d.min.js'
}, {
  entry: './index-network.js',
  filename: 'vis-network.min.js'
}, {
  entry: './index-graph3d.js',
  filename: 'vis-graph3d.min.js'
}];
var INDIVIDUAL_CSS_BUNDLES = [{
  entry: ['./lib/shared/**/*.css', './lib/timeline/**/*.css'],
  filename: 'vis-timeline-graph2d.min.css'
}, {
  entry: ['./lib/shared/**/*.css', './lib/network/**/*.css'],
  filename: 'vis-network.min.css'
}];

// generate banner with today's date and correct version
function createBanner() {
  var today = gutil.date(new Date(), 'yyyy-mm-dd'); // today, formatted as yyyy-mm-dd
  var version = require('./package.json').version;

  return String(fs.readFileSync(HEADER))
    .replace('@@date', today)
    .replace('@@version', version);
}

var bannerPlugin = new webpack.BannerPlugin(createBanner(), {
  entryOnly: true,
  raw: true
});

var webpackModule = {
  loaders: [{
    test: /\.js$/,
    exclude: /node_modules/,
    loader: 'babel-loader',
    query: {
      cacheDirectory: true, // use cache to improve speed
      babelrc: true // use the .baberc file
    }
  }],

  // exclude requires of moment.js language files
  wrappedContextRegExp: /$^/
};

var webpackConfig = {
  entry: ENTRY,
  output: {
    library: 'vis',
    libraryTarget: 'umd',
    path: DIST,
    filename: VIS_JS,
    sourcePrefix: '  '
  },
  module: webpackModule,
  plugins: [bannerPlugin],
  cache: true,

  // generate details s    tests: root + 'tests/',ourcempas of webpack modules
  devtool: 'source-map'

  //debug: true,
  //bail: true
};

var uglifyConfig = {
  outSourceMap: VIS_MAP,
  output: {
    comments: /@license/
  }
};

// create a single instance of the compiler to allow caching
var compiler = webpack(webpackConfig);

function handleCompilerCallback(err, stats) {
  if (err) {
    gutil.log(err.toString());
  }

  if (stats && stats.compilation && stats.compilation.errors) {
    // output soft errors
    stats.compilation.errors.forEach(function(err) {
      gutil.log(err.toString());
    });

    if (err || stats.compilation.errors.length > 0) {
      gutil.beep(); // TODO: this does not work on my system
    }
  }
}

function startDevWebserver(options, cb) {
  var opt = options || {};
  return gulp.src('./').pipe(webserver(Object.assign(opt, {
    path: '/',
    port: geminiConfig.webserver.port,
    middleware: function(req, res, next) {
      var dynamicTestBase = '/test/gemini/tests/dynamic/';
      var url = req.url;
      if (url.startsWith(dynamicTestBase)) {
        // get testcase from url
        var testName = url.split(dynamicTestBase)[1];

        // if testcase exists open settings
        var testConfig = require('.' + req.url + '.test');
        testConfig.name = testName;

        // render and send
        var templateFile = '.' + dynamicTestBase + 'dynamic.tmpl.html';
        ejs.renderFile(templateFile, testConfig, {}, function(err, html){
          if (err) {
            res.statusCode = 500;
            res.write('error rendering "'+ templateFile + '" (' + err + ')');
            res.end();
            return err;
          }
          res.writeHead(200, {
            'Content-Length': Buffer.byteLength(html),
            'Content-Type': 'text/html; charset=utf-8'
          });
          res.write(html);
          res.end();
        });
      }
      next();
    }
  })));
}

// Starts a static webserver that serve files from the root-dir of the project
// during development. This is also used for gemini-testing.
gulp.task('webserver', function(cb) {
  startDevWebserver({
    livereload: true,
    directoryListing: true,
    open: true
  }, cb);
});

function runGemini(mode, cb) {
  var completed = false;
  var hasError = false;

  // start development webserver to server the test-files
  var server = startDevWebserver();

  // start phantomjs in webdriver mode
  var phantomjsProcess = spawn('phantomjs', [
    '--webdriver=' + geminiConfig.phantomjs.port
  ]);

  // read output from the phantomjs process
  phantomjsProcess.stdout.on('data', function(data) {
    if (data.toString().indexOf('running on port') >= 0) {
      gutil.log("Started phantomjs webdriver");

      var geminiProcess = spawn('gemini', [mode, geminiConfig.gemini.tests]);
      geminiProcess.stdout.on('data', function(data) {
        var msg = data.toString().replace(/\n$/g, '');
        if (msg.startsWith('✓')) {
          gutil.log(gutil.colors.green(msg));
        } else if (msg.startsWith('✘')) {
          hasError = true;
          gutil.log(gutil.colors.red(msg));
        } else {
          gutil.log(msg);
        }
      });
      geminiProcess.stderr.on('data', function(data) {
        if (!(data.toString().indexOf('DeprecationWarning:') >= 0)) {
          hasError = true;
          gutil.log(gutil.colors.red(
            data.toString().replace(/\n$/g, '')
          ));
        }
      });
      geminiProcess.on('close', function(code) {
        completed = true;
        phantomjsProcess.kill();
      });
    }
  });

  // Log all error output from the phantomjs process to the console
  phantomjsProcess.stderr.on('data', function(data) {
    gutil.log(gutil.colors.red(data));
  });

  // Cleanup after phantomjs closes
  phantomjsProcess.on('close', function(code) {
    gutil.log("Phantomjs webdriver stopped");

    if (code && !completed) {
      // phantomjs closed with an error
      server.emit('kill');
      return cb(new Error('✘ phantomjs failed with code: ' + code + '\n' +
        'Check that port ' + geminiConfig.phantomjs.port +
        ' is free and that there are no other ' +
        'instances of phantomjs running. (`killall phantomjs`)'));
    }

    if (hasError) {
      // The tests returned with an error. Show the report. Keep dev-webserver running for debugging.
      gutil.log(gutil.colors.red("Opening error-report in webbrowser"));
      opn(geminiConfig.gemini.reports + 'index.html');
    } else {
      // The tests returned no error. Kill the dev-webserver and exit
      server.emit('kill');
      gutil.log("Webbrowser stopped");
      cb();
    }
  });
}

// Update the screenshots. Do this everytime you introduced a new test or introduced a major change.
gulp.task('gemini-update', function(cb) {
  runGemini('update', cb);
});

// Test the current (dist) version against the existing screenshots.
gulp.task('gemini-test', function(cb) {
  runGemini('test', cb);
});

// clean the dist/img directory
gulp.task('clean', function(cb) {
  rimraf(DIST + '/img', cb);
});

gulp.task('bundle-js', function(cb) {
  // update the banner contents (has a date in it which should stay up to date)
  bannerPlugin.banner = createBanner();

  compiler.run(function(err, stats) {
    handleCompilerCallback(err, stats);
    cb();
  });
});

// create individual bundles for timeline+graph2d, network, graph3d
gulp.task('bundle-js-individual', function(cb) {
  // update the banner contents (has a date in it which should stay up to date)
  bannerPlugin.banner = createBanner();

  async.each(INDIVIDUAL_JS_BUNDLES, function(item, callback) {
    var webpackTimelineConfig = {
      entry: item.entry,
      output: {
        library: 'vis',
        libraryTarget: 'umd',
        path: DIST,
        filename: item.filename,
        sourcePrefix: '  '
      },
      module: webpackModule,
      plugins: [bannerPlugin, new webpack.optimize.UglifyJsPlugin()],
      cache: true
    };

    var compiler = webpack(webpackTimelineConfig);
    compiler.run(function(err, stats) {
      handleCompilerCallback(err, stats);
      callback();
    });
  }, cb);

});

// bundle and minify css
gulp.task('bundle-css', function() {
  return gulp.src('./lib/**/*.css')
    .pipe(concat(VIS_CSS))
    .pipe(gulp.dest(DIST))
    // TODO: nicer to put minifying css in a separate task?
    .pipe(cleanCSS())
    .pipe(rename(VIS_MIN_CSS))
    .pipe(gulp.dest(DIST));
});

// bundle and minify individual css
gulp.task('bundle-css-individual', function(cb) {
  async.each(INDIVIDUAL_CSS_BUNDLES, function(item, callback) {
    return gulp.src(item.entry)
      .pipe(concat(item.filename))
      .pipe(cleanCSS())
      .pipe(rename(item.filename))
      .pipe(gulp.dest(DIST))
      .on('end', callback);
  }, cb);
});

gulp.task('copy', ['clean'], function() {
  var network = gulp.src('./lib/network/img/**/*')
    .pipe(gulp.dest(DIST + '/img/network'));

  return network;
});

gulp.task('minify', ['bundle-js'], function(cb) {
  var result = uglify.minify([DIST + '/' + VIS_JS], uglifyConfig);

  // note: we add a newline '\n' to the end of the minified file to prevent
  //       any issues when concatenating the file downstream (the file ends
  //       with a comment).
  fs.writeFileSync(DIST + '/' + VIS_MIN_JS, result.code + '\n');
  fs.writeFileSync(DIST + '/' + VIS_MAP, result.map.replace(/"\.\/dist\//g,
    '"'));

  cb();
});

gulp.task('bundle', ['bundle-js', 'bundle-js-individual', 'bundle-css',
  'bundle-css-individual', 'copy'
]);

// read command line arguments --bundle and --minify
var bundle = 'bundle' in argv;
var minify = 'minify' in argv;
var watchTasks = [];
if (bundle || minify) {
  // do bundling and/or minifying only when specified on the command line
  watchTasks = [];
  if (bundle) watchTasks.push('bundle');
  if (minify) watchTasks.push('minify');
} else {
  // by default, do both bundling and minifying
  watchTasks = ['bundle', 'minify'];
}

// The watch task (to automatically rebuild when the source code changes)
gulp.task('watch', watchTasks, function() {
  gulp.watch(['index.js', 'lib/**/*'], watchTasks);
});

// The default task (called when you run `gulp`)
gulp.task('default', ['clean', 'bundle', 'minify']);
