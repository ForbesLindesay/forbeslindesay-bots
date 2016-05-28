import gitHub from 'github-basic';
import Promise from 'promise';
import throat from 'throat';
import chalk from 'chalk';

const client = gitHub({version: 3, auth: process.env.GITHUB_TOKEN});
const betaClient = gitHub({version: 3, auth: process.env.GITHUB_TOKEN});
betaClient._version = 'application/vnd.github.polaris-preview+json';
const logins = [
  'ForbesLindesay-Bot',
  'greenkeeperio-bot',
];

function isMergable(issue) {
  if (!issue.pull_request) return false;
  if (logins.indexOf(issue.user.login) !== -1) {
    // at least one hour old
    return issue.updated_at < (new Date(Date.now() - 1000 * 60 * 60)).toISOString();
  }
  return false;
}
function mergePullRequest(pr) {
  return client.get(pr.commits_url).then(commits => {
    if (commits.length === 1) {
      return betaClient.put('/repos/:owner/:repo/pulls/:number/merge', {
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        number: pr.number,
        commit_title: commits[0].commit.message.split('\n\n')[0] + ' (#' + pr.number + ')',
        commit_message: commits[0].commit.message.split('\n\n').slice(1).join('\n\n'),
        sha: pr.head.sha,
        squash: true,
      }).then(res => {
        if (res.merged) console.log('merged');
        if (res.merged && pr.head.repo.id === pr.base.repo.id) {
          return client.delete('/repos/:owner/:repo/git/refs/:ref',
            {
              owner: pr.head.repo.owner.login,
              repo: pr.head.repo.name,
              ref: 'heads/' + pr.head.ref,
            }
          );
        }
      });
    }
  });
}
function handlePullRequest(pr) {
  if (!pr.mergeable) return null;
  return client.get(pr.statuses_url).then(
    statuses => {
      const statusesMap = {};
      statuses.forEach(status => {
        if (!statusesMap[status.context] || status.created_at > statusesMap[status.context]) {
          statusesMap[status.context] = status.created_at;
        }
      });
      statuses = statuses.filter(
        status => status.created_at === statusesMap[status.context]
      );
      if (statuses.length && statuses.every(status => status.state === 'success')) {
        console.log(chalk.green('merging:'));
        console.log(pr.title);
        console.dir(pr.html_url);
        return mergePullRequest(pr);
      } else {
        console.log(chalk.red('not merging:'));
        console.log(pr.title);
        console.dir(pr.html_url);
      }
    }
  );
}

function run(getIssues) {
  let getNext = null;
  return getIssues().then(issues => {
    getNext = issues.getNext;
    return Promise.all(
      issues.filter(isMergable).map(
        throat(1, issue => client.get(issue.pull_request.url).then(pr => handlePullRequest(pr)))
      )
    );
  }).then(() => {
    if (getNext) return run(getNext);
  });
}
export default function (data) {
  return run(() => client.get('/issues', {filter: 'all', state: 'open'}));
}
