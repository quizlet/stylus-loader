'use strict';

// Spec for stylesheet imports that stylus-loader hands to stylus's globbing
// finder. Run with stylus >=0.54.5 and <0.60.0 (the peer range this loader
// can still execute). stylus 0.60+ rejects the loader's visitor before the
// finder runs, which hides the bug instead of fixing it.
//
//   npm install
//   npm install stylus@0.59.0 --no-save --no-audit --no-fund
//   node --test --test-concurrency=1 security/import-escape.test.js

var fs = require('fs');
var path = require('path');
var os = require('os');
var assert = require('assert');
var test = require('node:test').test;

var stylusVersion = require('stylus/package.json').version;
var versionParts = stylusVersion.split('.').map(function (part) {
  return parseInt(part, 10);
});
if (versionParts[0] !== 0 || versionParts[1] < 54 || versionParts[1] >= 60) {
  throw new Error(
    'import-escape tests need stylus >=0.54.5 <0.60.0 so the loader reaches ' +
    'its finder. Installed stylus is ' + stylusVersion + '. ' +
    'Run: npm install stylus@0.59.0 --no-save --no-audit --no-fund'
  );
}

var events = [];
var original = {
  lstatSync: fs.lstatSync,
  readFileSync: fs.readFileSync,
  readFile: fs.readFile,
  openSync: fs.openSync,
  open: fs.open,
  realpathSync: fs.realpathSync,
  promiseReadFile: fs.promises.readFile
};

function record(kind, filePath) {
  if (typeof filePath === 'string') {
    events.push({ kind: kind, path: filePath });
  }
}

fs.lstatSync = function (filePath) {
  record('lstat', filePath);
  return original.lstatSync.apply(fs, arguments);
};
fs.readFileSync = function (filePath) {
  record('readFileSync', filePath);
  return original.readFileSync.apply(fs, arguments);
};
fs.readFile = function (filePath) {
  record('readFile', filePath);
  return original.readFile.apply(fs, arguments);
};
fs.openSync = function (filePath) {
  record('openSync', filePath);
  return original.openSync.apply(fs, arguments);
};
fs.open = function (filePath) {
  record('open', filePath);
  return original.open.apply(fs, arguments);
};
fs.promises.readFile = function (filePath) {
  record('readFile', typeof filePath === 'string' ? filePath : String(filePath));
  return original.promiseReadFile.apply(fs.promises, arguments);
};

var loader = require('../index.js');
var enhancedResolve = require('enhanced-resolve');

function within(root, target) {
  var relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function real(filePath) {
  try {
    return original.realpathSync(filePath);
  } catch (error) {
    return path.resolve(filePath);
  }
}

function contentReads(evts, outsideDir) {
  return evts.filter(function (event) {
    if (event.kind !== 'readFile' && event.kind !== 'readFileSync' &&
        event.kind !== 'open' && event.kind !== 'openSync') {
      return false;
    }
    return within(outsideDir, real(event.path)) || within(outsideDir, path.resolve(event.path));
  });
}

function run(source, project, entry, query) {
  var start = events.length;
  return new Promise(function (resolve) {
    var context = {
      cacheable: function () {},
      async: function () {
        return function (err, css, map) {
          resolve({
            err: err,
            css: css,
            map: map,
            events: events.slice(start)
          });
        };
      },
      resourcePath: entry,
      context: path.dirname(entry),
      rootContext: project,
      sourceMap: true,
      query: query || null,
      _compiler: { options: { context: project } },
      resolve: function (contextDir, request, callback) {
        enhancedResolve(contextDir, request, callback);
      },
      addDependency: function () {}
    };
    try {
      loader.call(context, source);
    } catch (error) {
      resolve({ err: error, css: null, map: null, events: events.slice(start) });
    }
  });
}

function leaked(result, markers) {
  return JSON.stringify({
    css: result.css || '',
    sourcesContent: result.map && result.map.sourcesContent || [],
    err: result.err && (result.err.stack || result.err.message || String(result.err)) || ''
  }).split('\n').filter(function (line) {
    return markers.some(function (marker) { return line.indexOf(marker) !== -1; });
  });
}

function assertContained(result, outsideDir, markers) {
  var reads = contentReads(result.events, outsideDir).map(function (event) {
    return event.kind + ' ' + real(event.path);
  });
  assert.deepEqual(reads, [], 'stylesheet import read a stylus file outside the compiler context');
  assert.deepEqual(leaked(result, markers), [], 'stylesheet output or error contains outside stylus source');
}

test('stylesheet imports cannot read stylus files outside the compiler context', async function (t) {
  var project = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-project-'));
  var outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-outside-'));
  var src = path.join(project, 'src');
  fs.mkdirSync(src);
  var entry = path.join(src, 'entry.styl');
  var secret = path.join(outside, 'secret.styl');
  var sourceComment = 'LEAK_SOURCE_COMMENT';
  var propValue = 'LEAK_PROP_VALUE';
  fs.writeFileSync(
    secret,
    '/* ' + sourceComment + ' */\nleak = ' + propValue + '\n.leak\n  color leak\n'
  );
  fs.writeFileSync(path.join(outside, 'secret-a.styl'), '.brace\n  content "LEAK_BRACE"\n');
  fs.writeFileSync(path.join(outside, 'other.styl'), '.star\n  content "LEAK_STAR"\n');
  fs.writeFileSync(
    path.join(outside, 'parent.styl'),
    '@import "secret.styl"\n.parent\n  content "LEAK_PARENT"\n'
  );
  fs.writeFileSync(path.join(project, 'ok.styl'), '.ok\n  content "INSIDE_OK"\n');
  fs.writeFileSync(path.join(src, 'local.styl'), '.local\n  content "LOCAL_OK"\n');
  fs.symlinkSync(secret, path.join(src, 'link.styl'));

  var relativeSecret = path.relative(src, secret);
  var markers = [sourceComment, propValue, 'LEAK_BRACE', 'LEAK_STAR', 'LEAK_PARENT'];

  await t.test('keeps parent-relative imports that stay inside the compiler context', async function () {
    var result = await run(
      '@import "../ok.styl"\n@import "./local.styl"\n.entry\n  color #111\n',
      project,
      entry
    );
    assert.ok(!result.err, result.err && (result.err.stack || result.err.message));
    assert.match(result.css, /INSIDE_OK/);
    assert.match(result.css, /LOCAL_OK/);
    assert.deepEqual(contentReads(result.events, outside), []);
  });

  await t.test('does not read a parent-directory stylus import outside the compiler context', async function () {
    var result = await run('@import "' + relativeSecret + '"\n.entry\n  color #111\n', project, entry);
    assertContained(result, outside, [sourceComment, propValue]);
  });

  await t.test('does not read an absolute stylus import', async function () {
    var result = await run('@import "' + secret + '"\n.entry\n  color #111\n', project, entry);
    assertContained(result, outside, [sourceComment, propValue]);
  });

  await t.test('does not read a brace glob that matches a stylus file outside the compiler context', async function () {
    var pattern = path.join(outside, 'secret-{a,b}.styl');
    var result = await run('@import "' + pattern + '"\n.entry\n  color #111\n', project, entry);
    assertContained(result, outside, ['LEAK_BRACE', sourceComment]);
  });

  await t.test('does not read a star glob of stylus files outside the compiler context', async function () {
    var result = await run(
      '@import "' + path.join(outside, '*.styl') + '"\n.entry\n  color #111\n',
      project,
      entry
    );
    assertContained(result, outside, markers);
  });

  await t.test('does not follow an outside file imported by another outside stylus file', async function () {
    var result = await run(
      '@import "' + path.join(outside, 'parent.styl') + '"\n.entry\n  color #111\n',
      project,
      entry
    );
    assertContained(result, outside, [sourceComment, propValue, 'LEAK_PARENT']);
  });

  await t.test('does not read an outside stylus file reached by @require', async function () {
    var result = await run('@require "' + relativeSecret + '"\n.entry\n  color #111\n', project, entry);
    assertContained(result, outside, [sourceComment, propValue]);
  });

  await t.test('does not read an outside stylus file named by use()', async function () {
    var result = await run('use("' + relativeSecret + '")\n.entry\n  color #111\n', project, entry);
    assertContained(result, outside, [sourceComment, propValue]);
  });

  await t.test('does not read an outside stylus file named by json()', async function () {
    var result = await run('json("' + relativeSecret + '")\n.entry\n  color #111\n', project, entry);
    assertContained(result, outside, [sourceComment, propValue]);
  });

  await t.test('does not read a symlink inside the compiler context whose target is outside it', async function () {
    var result = await run('@import "./link.styl"\n.entry\n  color #111\n', project, entry);
    assertContained(result, outside, [sourceComment, propValue]);
  });

  await t.test('does not read an outside path supplied as the import option', async function () {
    var result = await run(
      '.entry\n  color #111\n',
      project,
      entry,
      { import: relativeSecret }
    );
    assertContained(result, outside, [sourceComment, propValue]);
  });

  await t.test('does not expand a non-matching brace glob before rejecting the import', async function () {
    var prefix = path.join(os.tmpdir(), 'stylus-brace-nomatch-' + process.pid);
    var pattern = prefix + '-{0..20}.styl';
    var before = events.length;
    var result = await run('@import "' + pattern + '"\n.entry\n  color #111\n', project, entry);
    var expanded = events.slice(before).filter(function (event) {
      return event.path.indexOf(path.basename(prefix)) !== -1;
    });
    assert.equal(
      expanded.length,
      0,
      'brace pattern touched the filesystem ' + expanded.length + ' times before the import finished'
    );
    var errText = result.err && (result.err.message || String(result.err)) || '';
    assert.ok(result.css || result.err, 'loader neither rendered nor rejected the import');
    assert.equal(errText.indexOf(sourceComment), -1);
  });

  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
