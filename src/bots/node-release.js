import assert from 'assert';
import gitHub from 'github-basic';
import Promise from 'promise';
import request from 'then-request';
import {maxSatisfying} from 'semver';

const client = gitHub({version: 3, auth: process.env.GITHUB_TOKEN});

function maxVersion(releases) {
  return maxSatisfying(
    releases.filter(
      release => /^v\d+\.\d+\.\d+$/.test(release.version),
    ).map(
      release => release.version.substr(1),
    ),
    '*',
  );
}
function getNodeVersion() {
  return Promise.all([
    request('https://nodejs.org/download/release/index.json')
      .getBody('utf8')
      .then(JSON.parse),
    request('https://index.docker.io/v1/repositories/circleci/node/tags')
      .getBody('utf8')
      .then(JSON.parse),
  ])
    .then(([releases, circleCITags]) => {
      return {
        isLTS: releases.reduce((all, release) => {
          if (/^v\d+\.\d+\.\d+$/.test(release.version)) {
            all[release.version.substr(1)] = !!release.lts;
          }
          return all;
        }, {}),
        stable: maxVersion(releases),
        lts: maxVersion(releases.filter(release => !!release.lts)),
        stable_circle: maxVersion(releases.filter(release => {
          return circleCITags.some(tag => 'v' + tag.name === release.version)
        })),
        lts_circle: maxVersion(releases.filter(release => {
          return !!release.lts && circleCITags.some(tag => 'v' + tag.name === release.version)
        }))
      };
    });
}

function getContent(owner, repo, path) {
  return client.get('/repos/:owner/:repo/contents/:path', {
    owner,
    repo,
    path,
  }).then(result => {
    assert(result.type === 'file', 'Expected result.type to be a file');
    assert(
      typeof result.content === 'string',
      'Expected result.content to be a string. This validation is security critical.',
    );
    return (new Buffer(result.content, result.encoding)).toString('utf8');
  });
}
function tryGetContent(owner, repo, path) {
  return getContent(owner, repo, path).then(
    content => ({exists: true, content}),
    err => {
      if (err.statusCode === 404) return {exists: false};
      else throw err;
    },
  );
}

function needsUpdate(owner, repo, version) {
  return Promise.all([
    getContent(owner, repo, 'package.json'),
    tryGetContent(owner, repo, '.circleci/config.yml'),
  ]).then(([oldPackageSrc, circle2]) => {
    const oldPackage = JSON.parse(oldPackageSrc);

    // If engines are already up to date, our work here is done
    if (
      oldPackage.engines.node === version.lts ||
      oldPackage.engines.node === version.stable
    ) {
      return false;
    }
    const mode = (
      (version.isLTS[oldPackage.engines.node] ? 'lts' : 'stable') +
      (circle2.exists ? '_circle' : '')
    );
    const branch = 'node-' + version[mode];
    return client.get('/repos/:owner/:repo/branches/:branch', {owner, repo, branch}).then(
      b => {
        assert(b.name === branch);
        // if the branch exists, the bot doesn't need to do anything more
        return false;
      },
      err => {
        if (err.statusCode !== 404) throw err;
        return mode;
      },
    );
  });
}

function updateRepo(owner, repo, version, {dryRun = false} = {}) {
  return needsUpdate(owner, repo, version).then(mode => {
    if (!mode) return [];
    console.log('Updating ' + owner + '/' + repo);
    return Promise.all([
      getContent(owner, repo, 'package.json'),
      tryGetContent(owner, repo, '.travis.yml'),
      tryGetContent(owner, repo, 'circle.yml'),
      tryGetContent(owner, repo, '.circleci/config.yml'),
    ]).then(([pkg, travis, circle, circle2]) => {
      const updates = [];
      const newPkg = pkg.replace(/\"node\"\: \"\d+\.\d+\.\d+\"/g, '"node": "' + version[mode] + '"');
      assert(newPkg !== pkg, 'Expected package.json to be edited');
      assert(
        JSON.parse(newPkg).engines.node === version[mode],
        'Expected package.json to be updated to current version',
      );
      updates.push({
        path: 'package.json',
        content: newPkg,
      });
      if (travis.exists) {
        const newTravisA = travis.content.replace(
          /node\_js\:\n {2}\- \"\d+\.\d+\.\d+\"/g,
          'node_js:\n  - "' + version[mode] + '"',
        );
        assert(travis.content !== newTravisA, 'Expected .travis.yml to be edited');

        const newTravisB = newTravisA.replace(
          /node\_js\: \d+\.\d+\.\d+/g,
          'node_js: ' + version[mode],
        );
        assert(newTravisA !== newTravisB, 'Expected .travis.yml to be edited');
        updates.push({
          path: '.travis.yml',
          content: newTravisB,
        });
      }
      if (circle.exists) {
        const newCircle = circle.content.replace(
          /node\:\n {4}version\: \d+\.\d+\.\d+/g,
          'node:\n    version: ' + version[mode],
        );
        assert(circle.content !== newCircle, 'Expected circle.yml to be edited');
        updates.push({
          path: 'circle.yml',
          content: newCircle,
        });
      }
      if (circle2.exists) {
        const newCircle2 = circle2.content.replace(
          /node\:\d+\.\d+\.\d+/g,
          'node:' + version[mode],
        );
        assert(circle2.content !== newCircle2, 'Expected .circleci/config.yml to be edited');
        updates.push({
          path: '.circleci/config.yml',
          content: newCircle2,
        });
      }
      const commit = {
        branch,
        message: 'Update to node v' + version[mode],
        updates,
      };
      const calls = [
        {method: 'branch', args: [owner, repo, 'master', branch]},
        {method: 'commit', args: [owner, repo, commit]},
        {
          method: 'pull',
          args: [
            {
              user: owner,
              repo,
              branch,
            },
            {
              user: owner,
              repo,
              branch: 'master',
            },
            {
              title: 'Update to node v' + version[mode],
              body: (
                'This is an automated pull request to update the version of node.js. You can ' +
                'find release notes for what changed in this release at ' +
                'https://nodejs.org/en/blog/release/v' + version[mode] + '/' +
                '\n\n' +
                'If integration tests pass, this pull request can be safely merged.'
              ),
            },
          ],
        },
      ];
      if (dryRun) {
        return calls;
      } else {
        return calls.reduce((ready, call) => {
          return ready.then(() => client[call.method](...call.args));
        }, Promise.resolve(null)).then(() => calls);
      }
    });
  });
}

export default function (data) {
  return getNodeVersion().then(
    version => {
      return Promise.all([
        updateRepo('ForbesLindesay', 'forbeslindesay-bots', version, data),
        updateRepo('ForbesLindesay', 'tempjs.org', version, data),
        updateRepo('esdiscuss', 'bot', version, data),
        updateRepo('esdiscuss', 'esdiscuss.org', version, data),
        updateRepo('readable-email', 'readable-email-bot', version, data),
        updateRepo('readable-email', 'readable-email-site', version, data),
        updateRepo('jepso', 'MAPS', version, data),
        updateRepo('jepso', 'canoeslalomentries', version, data),
      ]);
    },
  );
}
