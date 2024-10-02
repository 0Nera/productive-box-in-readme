/**
 * Forked from https://github.com/maxam2017/productive-box
 */

import { resolve } from 'path';
import { config } from 'dotenv';
import { Octokit } from '@octokit/rest';

import githubQuery from './githubQuery';
import generateBarChart from './generateBarChart';
import { userInfoQuery, createContributedRepoQuery, createCommittedDateQuery } from './queries';
/**
 * get environment variable
 */
config({ path: resolve(__dirname, '../.env') });

interface IRepo {
  name: string;
  owner: string;
}

(async() => {
  /**
   * First, get user id
   */
  const userResponse = await githubQuery(userInfoQuery)
    .catch(error => console.error(`Unable to get username and id\n${error}`));
  const { login: username, id } = userResponse?.data?.viewer;

  /**
   * Second, get contributed repos
   */
  const contributedRepoQuery = createContributedRepoQuery(username);
  const repoResponse = await githubQuery(contributedRepoQuery)
    .catch(error => console.error(`Unable to get the contributed repo\n${error}`));
  const repos: IRepo[] = repoResponse?.data?.user?.repositoriesContributedTo?.nodes
    .filter(repoInfo => (!repoInfo?.isFork))
    .map(repoInfo => ({
      name: repoInfo?.name,
      owner: repoInfo?.owner?.login,
    }));

  /**
   * Third, get commit time and parse into commit-time/hour diagram
   */
  const committedTimeResponseMap = await Promise.all(
    repos.map(({name, owner}) => githubQuery(createCommittedDateQuery(id, name, owner)))
  ).catch(error => console.error(`Unable to get the commit info\n${error}`));

  if (!committedTimeResponseMap) return;

  let morning = 0; // 6 - 11
  let daytime = 0; // 11 - 18
  let evening = 0; // 18 - 23
  let night = 0; // 23 - 6

  committedTimeResponseMap.forEach(committedTimeResponse => {
    committedTimeResponse?.data?.repository?.defaultBranchRef?.target?.history?.edges.forEach(edge => {
      const committedDate = edge?.node?.committedDate;
      const timeString = new Date(committedDate).toLocaleTimeString('en-US', { hour12: false, timeZone: process.env.TIMEZONE });
      const hour = +(timeString.split(':')[0]);

      /**
       * voting and counting
       */
      if (hour >= 6 && hour < 11) morning++;
      if (hour >= 11 && hour < 18) daytime++;
      if (hour >= 18 && hour < 23) evening++;
      if ((hour >= 23 && hour < 24) || (hour >= 0 && hour < 6)) night++;
    });
  });

  /**
   * Next, generate diagram
   */
  const sum = morning + daytime + evening + night;
  if (!sum) return;

  const oneDay = [
    { label: '🌞 Утро', commits: morning },
    { label: '🌆 День', commits: daytime },
    { label: '🌃 Вечер', commits: evening },
    { label: '🌙 Ночь', commits: night },
  ];

  const lines = oneDay.reduce((prev, cur) => {
    const percent = cur.commits / sum * 100;
    const line = [
      `${cur.label}`.padEnd(10),
      `${cur.commits.toString().padStart(5)} изменений`.padEnd(14),
      generateBarChart(percent, 21),
      String(percent.toFixed(1)).padStart(5) + '%',
    ];

    return [...prev, line.join(' ')];
  }, []);

  /**
   * Finally, write into README.md
   */
  const octokit = new Octokit({ auth: `token ${process.env.GH_TOKEN}` });
  const readme = await octokit.repos.getReadme({
    owner: process.env.OWNER_REPO,
    repo: process.env.OWNER_REPO,
  }).catch(error => console.error(`Unable to get README\n${error}`));
  if (!readme) return;

  const readmeContent = Buffer.from(readme.data.content, 'base64').toString('utf8');
  const sha = readme.data.sha;
  const startComment = '<!--START_SECTION:productive-box-in-readme-->';
  const endComment = '<!--END_SECTION:productive-box-in-readme-->';

  const title = (morning + daytime) > (evening + night) ? 'Я активнее днём' : 'Я активнее ночью';
  const productiveBoxContent = '```text\n' + title + '\n\n' + lines.join('\n') + '\n```';
  const sectionContent = `${startComment}\n${productiveBoxContent}\n${endComment}`;

  const regex = new RegExp(`${startComment}[\\d\\D]*?${endComment}`);
  const newContent = Buffer.from(readmeContent.replace(regex, sectionContent), 'utf8').toString('base64');

  await octokit.repos.createOrUpdateFile({
    owner: process.env.OWNER_REPO,
    repo: process.env.OWNER_REPO,
    path: process.env.PATH,
    message: '(Automated) Update README.md',
    content: newContent,
    sha: sha
  }).catch(error => console.error(`Unable to update README\n${error}`));
})();
