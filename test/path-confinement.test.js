// Spec for confining stylesheet file reads to the project root.
//
// These tests fail while the loader evaluates attacker-controlled Stylus with
// the stock file builtins. They pass once a read is refused, or the bytes that
// are compiled are the bytes of a file whose real path is inside the project,
// with no side effect from a file outside it.
//
// Project root for this process is the loader context: this.rootContext and
// this.options.context, and the working directory while the loader runs.
// The stylesheet lives in a subdirectory of that root.
//
// Run (stylus 0.59.0 is the newest release this loader can evaluate;
// package.json allows >=0.52.4, and 0.60+ throws before render):
//
//   npm install
//   npm install stylus@0.59.0 --no-save --no-package-lock
//   node --test test/path-confinement.test.js

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var test = require('node:test').test;

var OUTSIDE_JSON = 'placeholder-outside-marker';
var INSIDE_JSON = 'placeholder-inside-marker';
var OUTSIDE_IMPORT = 'outside-import-marker';
var INSIDE_IMPORT = 'inside-import-marker';
var OUTSIDE_EMBED = 'embedurl-outside-marker';
var INSIDE_EMBED = 'embedurl-inside-marker';
var OUTSIDE_USE = 'use-outside-marker';
var INSIDE_USE = 'use-inside-marker';
var OUTSIDE_WIDTH = 41;
var INSIDE_WIDTH = 8;
var fsPatch = null;

if (process.argv.indexOf('--toctou-child') !== -1) {
  runToctouChild();
} else {
  test('stylesheet file reads stay inside the project root', function() {
    var failures = [];
    var cases = negativeCases().concat(positiveCases());
    var i = 0;

    function next() {
      if (i >= cases.length) {
        try {
          runToctouParent();
        } catch (err) {
          failures.push(err.message);
        }
        if (failures.length) {
          throw new Error(failures.join('\n'));
        }
        return;
      }
      var item = cases[i++];
      return item.fn().then(function() {
        return next();
      }, function(err) {
        failures.push(item.name + ': ' + err.message);
        return next();
      });
    }

    return next();
  });
}

function negativeCases() {
  return [
    {
      name: 'json() parent path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'json(' + stylusString(path.join('..', '..', 'outside', 'creds.json')) + ')',
            'body',
            '  content: marker'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [OUTSIDE_JSON]);
          });
        });
      }
    },
    {
      name: 'json() hash mode parent path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'vars = json(' + stylusString(path.join('..', '..', 'outside', 'creds.json')) + ', { hash: true })',
            'body',
            '  content: vars.marker'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [OUTSIDE_JSON]);
          });
        });
      }
    },
    {
      name: 'json() absolute path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'json(' + stylusString(path.join(fx.outside, 'creds.json')) + ')',
            'body',
            '  content: marker'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [OUTSIDE_JSON]);
          });
        });
      }
    },
    {
      name: 'json() symlink inside the stylesheet directory pointing outside the project',
      fn: function() {
        return withFixture(function(fx) {
          fs.symlinkSync(path.join(fx.outside, 'creds.json'), path.join(fx.styles, 'link.json'));
          return compile(fx, [
            'json("link.json")',
            'body',
            '  content: marker'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [OUTSIDE_JSON]);
          });
        });
      }
    },
    {
      name: 'image-size() parent path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'body',
            '  width: image-size(' + stylusString(path.join('..', '..', 'outside', 'pic.png')) + ')[0]'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [OUTSIDE_WIDTH + 'px']);
          });
        });
      }
    },
    {
      name: 'image-size() absolute path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'body',
            '  width: image-size(' + stylusString(path.join(fx.outside, 'pic.png')) + ')[0]'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [OUTSIDE_WIDTH + 'px']);
          });
        });
      }
    },
    {
      name: 'embedurl() parent path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          var encoded = Buffer.from(fx.outsideSvg).toString('base64');
          return compile(fx, [
            'body',
            '  background: embedurl(' + stylusString(path.join('..', '..', 'outside', 'mark.svg')) + ')'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [encoded, OUTSIDE_EMBED]);
          });
        });
      }
    },
    {
      name: 'embedurl() absolute path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          var encoded = Buffer.from(fx.outsideSvg).toString('base64');
          return compile(fx, [
            'body',
            '  background: embedurl(' + stylusString(path.join(fx.outside, 'mark.svg')) + ')'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [encoded, OUTSIDE_EMBED]);
          });
        });
      }
    },
    {
      name: 'use() parent path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'use(' + stylusString(path.join('..', '..', 'outside', 'plugin.js')) + ')',
            'body',
            '  content: outsidePlugin()'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [OUTSIDE_USE], [fx.useSentinel]);
          });
        });
      }
    },
    {
      name: 'use() absolute path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'use(' + stylusString(path.join(fx.outside, 'plugin.js')) + ')',
            'body',
            '  content: outsidePlugin()'
          ].join('\n')).then(function(result) {
            assertNoLeak(result, [OUTSIDE_USE], [fx.useSentinel]);
          });
        });
      }
    },
    {
      name: '@import parent path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, '@import ' + stylusString(path.join('..', '..', 'outside', 'leak.styl'))).then(function(result) {
            assertNoLeak(result, [OUTSIDE_IMPORT]);
          });
        });
      }
    },
    {
      name: '@import absolute path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, '@import ' + stylusString(path.join(fx.outside, 'leak.styl'))).then(function(result) {
            assertNoLeak(result, [OUTSIDE_IMPORT]);
          });
        });
      }
    },
    {
      name: '@require parent path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, '@require ' + stylusString(path.join('..', '..', 'outside', 'leak.styl'))).then(function(result) {
            assertNoLeak(result, [OUTSIDE_IMPORT]);
          });
        });
      }
    },
    {
      name: '@require absolute path outside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, '@require ' + stylusString(path.join(fx.outside, 'leak.styl'))).then(function(result) {
            assertNoLeak(result, [OUTSIDE_IMPORT]);
          });
        });
      }
    }
  ];
}

function positiveCases() {
  return [
    {
      name: 'json() in the stylesheet directory',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'json("local.json")',
            'body',
            '  content: marker'
          ].join('\n')).then(function(result) {
            assertAllowed(result, INSIDE_JSON);
          });
        });
      }
    },
    {
      name: 'json() parent path that stays inside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'json(' + stylusString(path.join('..', 'ok.json')) + ')',
            'body',
            '  content: marker'
          ].join('\n')).then(function(result) {
            assertAllowed(result, INSIDE_JSON);
          });
        });
      }
    },
    {
      name: 'json() absolute path inside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'json(' + stylusString(path.join(fx.project, 'ok.json')) + ')',
            'body',
            '  content: marker'
          ].join('\n')).then(function(result) {
            assertAllowed(result, INSIDE_JSON);
          });
        });
      }
    },
    {
      name: 'json() symlink whose real path stays inside the project',
      fn: function() {
        return withFixture(function(fx) {
          fs.symlinkSync(path.join(fx.project, 'ok.json'), path.join(fx.styles, 'inside-link.json'));
          return compile(fx, [
            'json("inside-link.json")',
            'body',
            '  content: marker'
          ].join('\n')).then(function(result) {
            assertAllowed(result, INSIDE_JSON);
          });
        });
      }
    },
    {
      name: 'image-size() inside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'body',
            '  width: image-size(' + stylusString(path.join('..', 'pic.png')) + ')[0]'
          ].join('\n')).then(function(result) {
            assertAllowed(result, INSIDE_WIDTH + 'px');
          });
        });
      }
    },
    {
      name: 'embedurl() inside the project',
      fn: function() {
        return withFixture(function(fx) {
          var encoded = Buffer.from(fx.insideSvg).toString('base64');
          return compile(fx, [
            'body',
            '  background: embedurl(' + stylusString(path.join('..', 'mark.svg')) + ')'
          ].join('\n')).then(function(result) {
            assertAllowed(result, encoded);
          });
        });
      }
    },
    {
      name: 'use() inside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, [
            'use(' + stylusString(path.join('..', 'plugin.js')) + ')',
            'body',
            '  content: insidePlugin()'
          ].join('\n')).then(function(result) {
            assertAllowed(result, INSIDE_USE);
          });
        });
      }
    },
    {
      name: '@import inside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, '@import ' + stylusString(path.join('..', 'lib.styl'))).then(function(result) {
            assertAllowed(result, INSIDE_IMPORT);
          });
        });
      }
    },
    {
      name: '@require inside the project',
      fn: function() {
        return withFixture(function(fx) {
          return compile(fx, '@require ' + stylusString(path.join('..', 'lib.styl'))).then(function(result) {
            assertAllowed(result, INSIDE_IMPORT);
          });
        });
      }
    }
  ];
}

function runToctouParent() {
  var result = childProcess.spawnSync(process.execPath, [__filename, '--toctou-child'], {
    encoding: 'utf8',
    timeout: 20000
  });
  if (result.status !== 0) {
    throw new Error(
      'check-then-use child failed\n' +
      (result.stdout || '') +
      (result.stderr || '') +
      (result.error ? result.error.message : '')
    );
  }
}

function runToctouChild() {
  var fs = require('fs');
  var path = require('path');
  var failures = [];

  patchFs();

  var scenarios = [
    function jsonLink() {
      return withFixture(function(fx) {
        var link = path.join(fx.styles, 'link.json');
        fs.symlinkSync(path.join(fx.project, 'ok.json'), link);
        arm(link, function() {
          replaceSymlink(link, path.join(fx.outside, 'creds.json'));
        });
        return compile(fx, [
          'json("link.json")',
          'body',
          '  content: marker'
        ].join('\n')).then(function(result) {
          assertNoLeak(result, [OUTSIDE_JSON]);
        });
      });
    },
    function useLink() {
      return withFixture(function(fx) {
        var link = path.join(fx.styles, 'link.js');
        fs.symlinkSync(path.join(fx.project, 'plugin.js'), link);
        arm(link, function() {
          replaceSymlink(link, path.join(fx.outside, 'plugin.js'));
        });
        return compile(fx, [
          'use("link.js")',
          'body',
          '  content: insidePlugin()'
        ].join('\n')).then(function(result) {
          assertNoLeak(result, [OUTSIDE_USE], [fx.useSentinel]);
        });
      });
    },
    function imageLink() {
      return withFixture(function(fx) {
        var link = path.join(fx.styles, 'link.png');
        fs.symlinkSync(path.join(fx.project, 'pic.png'), link);
        arm(link, function() {
          replaceSymlink(link, path.join(fx.outside, 'pic.png'));
        });
        return compile(fx, [
          'body',
          '  width: image-size("link.png")[0]'
        ].join('\n')).then(function(result) {
          assertNoLeak(result, [OUTSIDE_WIDTH + 'px']);
        });
      });
    },
    function embedLink() {
      return withFixture(function(fx) {
        var link = path.join(fx.styles, 'link.svg');
        fs.symlinkSync(path.join(fx.project, 'mark.svg'), link);
        arm(link, function() {
          replaceSymlink(link, path.join(fx.outside, 'mark.svg'));
        });
        var encoded = Buffer.from(fx.outsideSvg).toString('base64');
        return compile(fx, [
          'body',
          '  background: embedurl("link.svg")'
        ].join('\n')).then(function(result) {
          assertNoLeak(result, [encoded, OUTSIDE_EMBED]);
        });
      });
    },
    function importLink() {
      return withFixture(function(fx) {
        var link = path.join(fx.styles, 'link.styl');
        fs.symlinkSync(path.join(fx.project, 'lib.styl'), link);
        arm(link, function() {
          replaceSymlink(link, path.join(fx.outside, 'leak.styl'));
        });
        return compile(fx, '@import "link.styl"').then(function(result) {
          assertNoLeak(result, [OUTSIDE_IMPORT]);
        });
      });
    },
    function requireLink() {
      return withFixture(function(fx) {
        var link = path.join(fx.styles, 'require-link.styl');
        fs.symlinkSync(path.join(fx.project, 'lib.styl'), link);
        arm(link, function() {
          replaceSymlink(link, path.join(fx.outside, 'leak.styl'));
        });
        return compile(fx, '@require "require-link.styl"').then(function(result) {
          assertNoLeak(result, [OUTSIDE_IMPORT]);
        });
      });
    }
  ];

  var chain = Promise.resolve();
  scenarios.forEach(function(fn) {
    chain = chain.then(function() {
      return fn().then(null, function(err) {
        failures.push(fn.name + ': ' + err.message);
      });
    });
  });

  chain.then(function() {
    if (failures.length) {
      console.error(failures.join('\n'));
      process.exit(1);
    }
    process.exit(0);
  }, function(err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}

function patchFs() {
  if (fsPatch) return;
  var origStat = fs.statSync;
  var origLstat = fs.lstatSync;
  var origRealpath = fs.realpathSync;
  var origRealpathNative = fs.realpathSync.native;
  var origOpen = fs.openSync;
  fsPatch = {
    armed: false,
    target: null,
    swap: null,
    origStat: origStat,
    origLstat: origLstat,
    origRealpath: origRealpath,
    origRealpathNative: origRealpathNative,
    origOpen: origOpen
  };

  function observe(filePath) {
    var hit = fsPatch.armed && samePath(filePath, fsPatch.target);
    return hit;
  }

  function after(hit) {
    if (!hit || !fsPatch.armed) return;
    fsPatch.armed = false;
    fsPatch.swap();
  }

  fs.statSync = function(filePath) {
    var hit = observe(filePath);
    var result = origStat.apply(fs, arguments);
    after(hit);
    return result;
  };
  fs.lstatSync = function(filePath) {
    var hit = observe(filePath);
    var result = origLstat.apply(fs, arguments);
    after(hit);
    return result;
  };
  fs.realpathSync = function(filePath) {
    var hit = observe(filePath);
    var result = origRealpath.apply(fs, arguments);
    after(hit);
    return result;
  };
  if (origRealpathNative) {
    fs.realpathSync.native = function(filePath) {
      var hit = observe(filePath);
      var result = origRealpathNative.apply(fs, arguments);
      after(hit);
      return result;
    };
  }
  fs.openSync = function(filePath) {
    var hit = observe(filePath);
    var result = origOpen.apply(fs, arguments);
    after(hit);
    return result;
  };
}

function arm(target, swap) {
  patchFs();
  fsPatch.armed = true;
  fsPatch.target = target;
  fsPatch.swap = swap;
}

function replaceSymlink(linkPath, nextTarget) {
  fs.unlinkSync(linkPath);
  fs.symlinkSync(nextTarget, linkPath);
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return path.resolve(left) === path.resolve(right);
}

function assertNoLeak(result, needles, sideEffects) {
  if (result.err && /Class constructor/.test(result.err)) {
    throw new Error('loader crashed before the file builtin ran: ' + result.err);
  }
  (sideEffects || []).forEach(function(filePath) {
    if (fs.existsSync(filePath)) {
      throw new Error('outside file ran a side effect at ' + filePath);
    }
  });
  if (!result.css) return;
  needles.forEach(function(needle) {
    if (result.css.indexOf(needle) !== -1) {
      throw new Error('compiled CSS contains data from outside the project (' + needle + ')');
    }
  });
}

function assertAllowed(result, needle) {
  if (result.err) {
    throw new Error('in-project read was refused: ' + result.err);
  }
  if (!result.css || result.css.indexOf(needle) === -1) {
    throw new Error('in-project read did not reach the CSS (missing ' + needle + ')');
  }
}

function compile(fx, source) {
  var loader = require('../index.js');
  var resourcePath = path.join(fx.styles, 'entry.styl');
  fs.writeFileSync(resourcePath, source);
  var previous = process.cwd();

  return new Promise(function(resolve) {
    var settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      try { process.chdir(previous); } catch (err) {}
      resolve(result);
    }

    var ctx = {
      resourcePath: resourcePath,
      context: fx.styles,
      rootContext: fx.project,
      options: { context: fx.project },
      cacheable: function() {},
      addDependency: function() {},
      resolve: function(context, request, callback) {
        callback(new Error('resolve miss'));
      },
      async: function() {
        return function(err, css) {
          finish({
            err: err ? String(err.message || err) : null,
            css: css == null ? null : String(css)
          });
        };
      }
    };

    try {
      process.chdir(fx.project);
      loader.call(ctx, source);
    } catch (err) {
      finish({ err: String(err.message || err), css: null });
    }

    setTimeout(function() {
      finish({ err: 'loader produced no result', css: null });
    }, 5000);
  });
}

function withFixture(fn) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-confine-'));
  var project = path.join(root, 'project');
  var outside = path.join(root, 'outside');
  var styles = path.join(project, 'styles');
  fs.mkdirSync(styles, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  var outsideSvg = '<svg xmlns="http://www.w3.org/2000/svg">' + OUTSIDE_EMBED + '</svg>';
  var insideSvg = '<svg xmlns="http://www.w3.org/2000/svg">' + INSIDE_EMBED + '</svg>';
  var useSentinel = path.join(outside, 'use-sentinel.txt');

  fs.writeFileSync(
    path.join(outside, 'creds.json'),
    JSON.stringify({ marker: OUTSIDE_JSON })
  );
  fs.writeFileSync(
    path.join(project, 'ok.json'),
    JSON.stringify({ marker: INSIDE_JSON })
  );
  fs.writeFileSync(
    path.join(styles, 'local.json'),
    JSON.stringify({ marker: INSIDE_JSON })
  );
  fs.writeFileSync(path.join(outside, 'pic.png'), png(OUTSIDE_WIDTH, 2));
  fs.writeFileSync(path.join(project, 'pic.png'), png(INSIDE_WIDTH, 2));
  fs.writeFileSync(path.join(outside, 'mark.svg'), outsideSvg);
  fs.writeFileSync(path.join(project, 'mark.svg'), insideSvg);
  fs.writeFileSync(
    path.join(outside, 'leak.styl'),
    'leaked\n  marker ' + OUTSIDE_IMPORT + '\n'
  );
  fs.writeFileSync(
    path.join(project, 'lib.styl'),
    'kept\n  marker ' + INSIDE_IMPORT + '\n'
  );
  fs.writeFileSync(path.join(outside, 'plugin.js'), pluginSource(useSentinel, 'outsidePlugin', OUTSIDE_USE));
  fs.writeFileSync(path.join(project, 'plugin.js'), pluginSource(null, 'insidePlugin', INSIDE_USE));

  var fx = {
    root: root,
    project: project,
    outside: outside,
    styles: styles,
    outsideSvg: outsideSvg,
    insideSvg: insideSvg,
    useSentinel: useSentinel
  };

  return Promise.resolve(fn(fx)).then(function(value) {
    fs.rmSync(root, { recursive: true, force: true });
    return value;
  }, function(err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  });
}

function pluginSource(sentinelPath, fnName, marker) {
  var write = sentinelPath
    ? 'require("fs").writeFileSync(' + JSON.stringify(sentinelPath) + ', "ran");\n'
    : '';
  return [
    write + 'module.exports = function() {',
    '  return function(style) {',
    '    style.define(' + JSON.stringify(fnName) + ', function() {',
    '      return ' + JSON.stringify(marker) + ';',
    '    });',
    '  };',
    '};',
    ''
  ].join('\n');
}

function png(width, height) {
  var signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  var length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  var type = Buffer.from('IHDR');
  var data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  return Buffer.concat([signature, length, type, data, Buffer.alloc(4)]);
}

function stylusString(value) {
  return JSON.stringify(value);
}
