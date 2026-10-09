// Uses Git Credential Manager in memory; credentials never go into files or logs.
async function git(args: string[], input?: string) {
  const p = Bun.spawn(['git', ...args], { stdin: input ? new Blob([input]) : 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GCM_INTERACTIVE: 'Never' } });
  const output = await new Response(p.stdout).text();
  const error = await new Response(p.stderr).text();
  if (await p.exited !== 0) throw new Error(`git ${args[0]} failed: ${input ? 'credential unavailable' : error}`);
  return output.trim();
}
const credential = await git(['credential', 'fill'], 'protocol=https\nhost=github.com\nusername=vishal360\n\n');
const token = credential.split('\n').find(line => line.startsWith('password='))?.slice(9);
if (!token) throw new Error('Authenticate GitHub before publishing');
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'a-bot-and-a-dream' };
const userResponse = await fetch('https://api.github.com/user', { headers });
if (!userResponse.ok) throw new Error(`GitHub authentication failed (${userResponse.status})`);
const user = await userResponse.json() as { login: string; id: number };
const endpoint = `https://api.github.com/repos/${user.login}/a-bot-and-a-dream`;
let response = await fetch(endpoint, { headers });
if (response.status === 404) response = await fetch('https://api.github.com/user/repos', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'a-bot-and-a-dream', private: true, description: 'A Bot and a Dream — paper-first futures and crypto research terminal' }) });
if (!response.ok) throw new Error(`Repository creation/access failed (${response.status})`);
const repo = await response.json() as { private: boolean; clone_url: string; html_url: string };
if (!repo.private) throw new Error('Refusing to publish into an existing public repository');
if (!(await Bun.file('.git/HEAD').exists())) await git(['init', '-b', 'main']);
await git(['config', 'user.name', user.login]);
await git(['config', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`]);
await git(['add', '.']);
if (await git(['diff', '--cached', '--name-only'])) console.log(await git(['commit', '-m', 'Build paper-first terminal, research lab, persistent risk controls and tests']));
const remotes = await git(['remote']);
if (!remotes.split('\n').includes('origin')) await git(['remote', 'add', 'origin', repo.clone_url]);
else if (await git(['remote', 'get-url', 'origin']) !== repo.clone_url) throw new Error('Unexpected origin; refusing overwrite');
await git(['push', '-u', 'origin', 'main']);
const ref = await git(['ls-remote', 'origin', 'refs/heads/main']);
const local = await git(['rev-parse', 'HEAD']);
if (!ref.startsWith(local)) throw new Error('Remote verification failed');
console.log(`PUBLISHED AND VERIFIED: ${repo.html_url}\nCOMMIT: ${local}`);
export {};