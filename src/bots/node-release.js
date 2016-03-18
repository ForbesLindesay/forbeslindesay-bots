import assert from 'assert';
import gitHub from 'github-basic';
import Promise from 'promise';
import {maxSatisfying} from 'semver';

const client = gitHub({version: 3, auth: process.env.GITHUB_TOKEN});

function getNodeVersion() {
  return client.get('/repos/:owner/:repo/tags', {
    owner: 'nodejs',
    repo: 'node',
  }).then(releases => {
    return maxSatisfying(
      releases.filter(
        release => /^v\d+\.\d+\.\d+$/.test(release.name),
      ).map(
        release => release.name.substr(1),
      ),
      '*',
    );
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

function needsUpdate(owner, repo, currentVersion) {
  return getContent(owner, repo, 'package.json').then(oldPackageSrc => {
    const oldPackage = JSON.parse(oldPackageSrc);

    // If engines are already up to date, our work here is done
    if (oldPackage.engines.node === currentVersion) return false;

    const branch = 'node-' + currentVersion;
    return client.get('/repos/:owner/:repo/branches/:branch', {owner, repo, branch}).then(
      b => {
        assert(b.name === branch);
        // if the branch exists, the bot doesn't need to do anything more
        return false;
      },
      err => {
        if (err.statusCode !== 404) throw err;
        return true;
      },
    );
  });
}

function updateRepo(owner, repo, currentVersion, {dryRun = false} = {}) {
  const branch = 'node-' + currentVersion;
  return needsUpdate(owner, repo, currentVersion).then(isUpdateNeeded => {
    if (!isUpdateNeeded) return [];
    console.log('Updating ' + owner + '/' + repo);
    return Promise.all([
      getContent(owner, repo, 'package.json'),
      tryGetContent(owner, repo, '.travis.yml'),
      tryGetContent(owner, repo, 'circle.yml'),
    ]).then(([pkg, travis, circle]) => {
      const updates = [];
      const newPkg = pkg.replace(/\"node\"\: \"\d+\.\d+\.\d+\"/g, '"node": "' + currentVersion + '"');
      assert(newPkg !== pkg, 'Expected package.json to be edited');
      assert(
        JSON.parse(newPkg).engines.node === currentVersion,
        'Expected package.json to be updated to current version',
      );
      updates.push({
        path: 'package.json',
        content: newPkg,
      });
      if (travis.exists) {
        const newTravisA = travis.content.replace(
          /node\_js\:\n {2}\- \"\d+\.\d+\.\d+\"/g,
          'node_js:\n  - "' + currentVersion + '"',
        );
        assert(travis.content !== newTravisA, 'Expected .travis.yml to be edited');

        const newTravisB = newTravisA.replace(
          /node\_js\: \d+\.\d+\.\d+/g,
          'node_js: ' + currentVersion,
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
          'node:\n    version: ' + currentVersion,
        );
        assert(circle.content !== newCircle, 'Expected circle.yml to be edited');
        updates.push({
          path: 'circle.yml',
          content: newCircle,
        });
      }
      const commit = {
        branch,
        message: 'Update to node v' + currentVersion,
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
              title: 'Update to node v' + currentVersion,
              body: (
                'This is an automated pull request to update the version of node.js. You can ' +
                'find release notes for what changed in this release at ' +
                'https://nodejs.org/en/blog/release/v' + currentVersion + '/' +
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
      ]);
    },
  );
}
