var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var stylusVersion = require('stylus/package.json').version;
var PathCache = require('../lib/pathcache');
var loader = require('../');
var ResolverFactory = require('enhanced-resolve').ResolverFactory;
var NodeJsInputFileSystem = require('enhanced-resolve/lib/NodeJsInputFileSystem');
var CachedInputFileSystem = require('enhanced-resolve/lib/CachedInputFileSystem');

// stylus-loader 3.0.2 resolves imports with stylus APIs that throw before the
// walk when Visitor is an ES6 class (stylus >= 0.60). These tests run on
// stylus 0.54.5, which satisfies "stylus": ">=0.52.4" and still lists imports.
if (stylusVersion !== '0.54.5') {
  throw new Error(
    'cycle-resolution tests require stylus 0.54.5 (installed ' + stylusVersion +
    '). Run: npm install --no-save stylus@0.54.5'
  );
}

var inputFileSystem = new CachedInputFileSystem(new NodeJsInputFileSystem(), 60000);
var webpackResolver = ResolverFactory.createResolver({
  fileSystem: new NodeJsInputFileSystem(),
  extensions: ['.js', '.json', '.styl']
});

function webpackResolve(context, request, callback) {
  // Same call shape as webpack 2.7.0 NormalModule.createLoaderContext.
  webpackResolver.resolve({}, context, request, callback);
}

function missingWebpackResolve(context, request, callback) {
  callback(new Error('webpack resolver disabled for ' + request));
}

function writeTree(files) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-cycle-'));
  Object.keys(files).forEach(function(name) {
    var full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[name]);
  });
  return dir;
}

function basenames(paths) {
  var seen = {};
  paths.forEach(function(file) {
    seen[path.basename(file)] = true;
  });
  return Object.keys(seen).sort();
}

function countBy(values) {
  return values.reduce(function(map, value) {
    map[value] = (map[value] || 0) + 1;
    return map;
  }, {});
}

// Resolvers are wrapped so a cycle cannot retain promises until the process
// is killed. A walk that resolves a specifier again after the allowed number
// throws, which rejects createFromFile. The allowed number is one resolver
// attempt per static import specifier on one walk of each file.
function trackResolvers(filename, limit, resolve) {
  var calls = [];
  var resolvers = PathCache.resolvers({
    paths: [],
    filename: filename
  }, resolve || missingWebpackResolve).map(function(resolver) {
    return function(context, request) {
      calls.push(request);
      if (calls.length > limit) {
        var error = new Error(
          'unbounded import walk (' + calls.length + ' resolver calls, limit ' + limit + ')'
        );
        error.code = 'UNBOUNDED';
        throw error;
      }
      return resolver(context, request);
    };
  });
  return { calls: calls, resolvers: resolvers };
}

function resolveTree(dir, entryName, limit, resolve) {
  var entry = path.join(dir, entryName);
  var tracked = trackResolvers(entry, limit, resolve);
  var reads = [];
  var helpers = {
    resolvers: tracked.resolvers,
    readFile: function(file, callback) {
      reads.push(path.basename(file));
      return fs.readFile(file, callback);
    }
  };
  var source = fs.readFileSync(entry, 'utf8');
  var promise = PathCache.createFromFile(helpers, {
    contexts: {},
    sources: {},
    imports: {}
  }, source, entry);
  return { promise: promise, calls: tracked.calls, reads: reads, entry: entry };
}

function assertSettled(run, assertResult, done) {
  var finished = false;
  function finish(error) {
    if (finished) return;
    finished = true;
    done(error);
  }
  run.promise.then(function(cache) {
    try {
      assertResult(cache, run);
      finish();
    } catch (error) {
      finish(error);
    }
  }, function(error) {
    if (error && error.code === 'UNBOUNDED') {
      finish(new Error(
        error.message + '; requests=' + run.calls.join(',') +
        '; reads=' + run.reads.join(',')
      ));
      return;
    }
    finish(error);
  });
}

function loadStylesheet(dir, entryName, query, limit) {
  var entry = path.join(dir, entryName);
  var source = fs.readFileSync(entry, 'utf8');
  var calls = [];
  var deps = [];
  var originalResolvers = PathCache.resolvers;
  PathCache.resolvers = function() {
    var resolvers = originalResolvers.apply(null, arguments).map(function(resolver) {
      return function(context, request) {
        calls.push(request);
        if (calls.length > limit) {
          var error = new Error(
            'unbounded import walk (' + calls.length + ' resolver calls, limit ' + limit + ')'
          );
          error.code = 'UNBOUNDED';
          throw error;
        }
        return resolver(context, request);
      };
    });
    return resolvers;
  };
  PathCache.resolvers.reduce = originalResolvers.reduce;

  return new Promise(function(resolve) {
    var finished = false;
    function done(error, css) {
      if (finished) return;
      finished = true;
      PathCache.resolvers = originalResolvers;
      PathCache.resolvers.reduce = originalResolvers.reduce;
      resolve({ error: error, css: css, calls: calls.slice(), deps: deps.slice() });
    }
    var context = {
      resourcePath: entry,
      query: query || {},
      cacheable: function() {},
      async: function() { return done; },
      resolve: webpackResolve,
      addDependency: function(file) { deps.push(file); },
      _compiler: { inputFileSystem: inputFileSystem }
    };
    try {
      loader.call(context, source);
    } catch (error) {
      done(error);
    }
  });
}

function assertLoader(result, assertResult) {
  if (result.error && result.error.code === 'UNBOUNDED') {
    throw new Error(
      result.error.message + '; requests=' + result.calls.join(',') +
      '; deps=' + result.deps.join(',')
    );
  }
  assertResult(result);
}

describe('circular stylus import resolution', function() {
  this.timeout(4000);

  it('resolves an acyclic import once', function(done) {
    var dir = writeTree({
      'entry.styl': '@import "lib"\nbody\n  color red\n',
      'lib.styl': '.lib\n  color blue\n'
    });
    var run = resolveTree(dir, 'entry.styl', 1);
    assertSettled(run, function(cache, tracked) {
      assert.deepEqual(tracked.calls, ['lib']);
      assert.deepEqual(tracked.reads, ['lib.styl']);
      assert.deepEqual(basenames(cache.allDeps()), ['lib.styl']);
    }, done);
  });

  it('stops a dependency that imports itself', function(done) {
    var dir = writeTree({
      'entry.styl': '@import "evil"\nbody\n  color red\n',
      'evil.styl': '@import "evil"\n.evil\n  color blue\n'
    });
    // entry->evil and evil->evil. A second walk of evil would resolve "evil" again.
    var run = resolveTree(dir, 'entry.styl', 2);
    assertSettled(run, function(cache, tracked) {
      assert.deepEqual(tracked.calls, ['evil', 'evil']);
      assert.deepEqual(tracked.reads, ['evil.styl']);
      assert.deepEqual(basenames(cache.allDeps()), ['evil.styl']);
    }, done);
  });

  it('stops two stylesheets that import each other', function(done) {
    var dir = writeTree({
      'entry.styl': '@import "a"\n',
      'a.styl': '@import "b"\n.a\n  color red\n',
      'b.styl': '@import "a"\n.b\n  color blue\n'
    });
    var run = resolveTree(dir, 'entry.styl', 3);
    assertSettled(run, function(cache, tracked) {
      assert.deepEqual(tracked.calls, ['a', 'b', 'a']);
      assert.deepEqual(countBy(tracked.reads), { 'a.styl': 1, 'b.styl': 1 });
      assert.deepEqual(basenames(cache.allDeps()), ['a.styl', 'b.styl']);
    }, done);
  });

  it('stops a stylesheet that imports its own index', function(done) {
    var dir = writeTree({
      'entry.styl': '@import "pkg"\n',
      'pkg/index.styl': '@import "pkg"\n.pkg\n  color red\n'
    });
    // Each walk tries the file resolver, then the index resolver.
    var run = resolveTree(dir, 'entry.styl', 4);
    assertSettled(run, function(cache, tracked) {
      assert.deepEqual(tracked.calls, ['pkg', 'pkg', 'pkg', 'pkg']);
      assert.deepEqual(tracked.reads, ['index.styl']);
      assert.deepEqual(basenames(cache.allDeps()), ['index.styl']);
    }, done);
  });

  it('stops a block-level import cycle', function(done) {
    var dir = writeTree({
      'entry.styl': '.wrap\n  @import "evil"\n',
      'evil.styl': '.inner\n  @import "evil"\n'
    });
    var run = resolveTree(dir, 'entry.styl', 2);
    assertSettled(run, function(cache, tracked) {
      assert.deepEqual(tracked.calls, ['evil', 'evil']);
      assert.deepEqual(tracked.reads, ['evil.styl']);
      assert.deepEqual(basenames(cache.allDeps()), ['evil.styl']);
    }, done);
  });

  it('stops an @require cycle', function(done) {
    var dir = writeTree({
      'entry.styl': '@require "evil"\n',
      'evil.styl': '@require "evil"\n.evil\n  color red\n'
    });
    var run = resolveTree(dir, 'entry.styl', 2);
    assertSettled(run, function(cache, tracked) {
      assert.deepEqual(tracked.calls, ['evil', 'evil']);
      assert.deepEqual(tracked.reads, ['evil.styl']);
      assert.deepEqual(basenames(cache.allDeps()), ['evil.styl']);
    }, done);
  });

  it('stops a use() cycle', function(done) {
    var dir = writeTree({
      'entry.styl': 'use("evil")\n',
      'evil.styl': '@import "evil"\n.evil\n  width 1px\n'
    });
    var run = resolveTree(dir, 'entry.styl', 2);
    assertSettled(run, function(cache, tracked) {
      assert.deepEqual(tracked.calls, ['evil', 'evil']);
      assert.deepEqual(tracked.reads, ['evil.styl']);
      assert.deepEqual(basenames(cache.allDeps()), ['evil.styl']);
    }, done);
  });

  it('stops a json() cycle', function(done) {
    var dir = writeTree({
      'entry.styl': 'json("evil.styl")\n',
      'evil.styl': '@import "evil"\n'
    });
    var run = resolveTree(dir, 'entry.styl', 2);
    assertSettled(run, function(cache, tracked) {
      assert.deepEqual(tracked.calls, ['evil.styl', 'evil']);
      assert.deepEqual(countBy(tracked.reads), { 'evil.styl': 1 });
      assert.deepEqual(basenames(cache.allDeps()), ['evil.styl']);
    }, done);
  });

  it('walks each file once when imports reconverge', function(done) {
    var dir = writeTree({
      'entry.styl': '@import "a"\n@import "b"\n',
      'a.styl': '@import "c"\n@import "d"\n',
      'b.styl': '@import "c"\n@import "d"\n',
      'c.styl': '@import "e"\n@import "f"\n',
      'd.styl': '@import "e"\n@import "f"\n',
      'e.styl': '@import "leaf"\n',
      'f.styl': '@import "leaf"\n',
      'leaf.styl': '.leaf\n  color black\n'
    });
    // 12 specifier resolutions: 2+2+2+2+2+1+1. Another walk resolves one again.
    var run = resolveTree(dir, 'entry.styl', 12);
    assertSettled(run, function(cache, tracked) {
      assert.equal(tracked.calls.length, 12);
      assert.deepEqual(countBy(tracked.reads), {
        'a.styl': 1,
        'b.styl': 1,
        'c.styl': 1,
        'd.styl': 1,
        'e.styl': 1,
        'f.styl': 1,
        'leaf.styl': 1
      });
      assert.deepEqual(basenames(cache.allDeps()), [
        'a.styl', 'b.styl', 'c.styl', 'd.styl', 'e.styl', 'f.styl', 'leaf.styl'
      ]);
    }, done);
  });

  it('stops a self-import while compiling through the loader', function(done) {
    var dir = writeTree({
      'entry.styl': '@import "evil"\nbody\n  color red\n',
      'evil.styl': '@import "evil"\n.evil\n  color blue\n'
    });
    loadStylesheet(dir, 'entry.styl', {}, 2).then(function(result) {
      try {
        assertLoader(result, function(loaded) {
          assert.deepEqual(loaded.calls, ['evil', 'evil']);
          assert.ok(!loaded.error, loaded.error && loaded.error.stack);
          assert.ok(/\.evil/.test(loaded.css));
          assert.ok(/body/.test(loaded.css));
          assert.deepEqual(basenames(loaded.deps), ['evil.styl']);
        });
        done();
      } catch (error) {
        done(error);
      }
    }, done);
  });

  it('stops a self-import reached through the import option', function(done) {
    var dir = writeTree({
      'entry.styl': 'body\n  color red\n',
      'evil.styl': '@import "evil"\n.evil\n  color blue\n'
    });
    loadStylesheet(dir, 'entry.styl', { import: ['evil.styl'] }, 2).then(function(result) {
      try {
        assertLoader(result, function(loaded) {
          assert.deepEqual(loaded.calls, ['evil.styl', 'evil']);
          assert.ok(!loaded.error, loaded.error && loaded.error.stack);
          assert.ok(/\.evil/.test(loaded.css));
          assert.ok(/body/.test(loaded.css));
          assert.deepEqual(basenames(loaded.deps), ['evil.styl']);
        });
        done();
      } catch (error) {
        done(error);
      }
    }, done);
  });

  it('stops an entry file that imports itself when webpack resolves it', function(done) {
    var dir = writeTree({
      'entry.styl': '@import "entry"\nbody\n  color red\n'
    });
    var run = resolveTree(dir, 'entry.styl', 3, webpackResolve);
    assertSettled(run, function(cache, tracked) {
      // Stylus skips options.filename, so the webpack resolver returns the same file.
      assert.equal(tracked.calls.length, 3);
      assert.deepEqual(tracked.reads, []);
      assert.deepEqual(basenames(cache.allDeps()), ['entry.styl']);
    }, done);
  });

  it('finishes loader resolution when two stylesheets import each other', function(done) {
    var dir = writeTree({
      'entry.styl': '@import "a"\n',
      'a.styl': '@import "b"\n.a\n  color red\n',
      'b.styl': '@import "a"\n.b\n  color blue\n'
    });
    loadStylesheet(dir, 'entry.styl', {}, 3).then(function(result) {
      try {
        assertLoader(result, function(loaded) {
          assert.deepEqual(loaded.calls, ['a', 'b', 'a']);
          assert.deepEqual(basenames(loaded.deps), ['a.styl', 'b.styl']);
        });
        done();
      } catch (error) {
        done(error);
      }
    }, done);
  });
});
