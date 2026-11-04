import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function releaseCheck(eventName: string, ref: string, message: string): boolean {
  return (
    eventName === 'push' &&
    ref === 'refs/heads/master' &&
    message.split(/\r?\n/).includes('Release-Check: true')
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  const release = releaseCheck(
    process.env.GITHUB_EVENT_NAME!,
    process.env.GITHUB_REF!,
    event.head_commit?.message ?? '',
  );
  await appendFile(
    process.env.GITHUB_OUTPUT!,
    `release=${release}\nfull=${release || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'}\n`,
  );
}
