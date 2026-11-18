/**
 * Common technical failures in plain words. The first match wins; anything else is shown as it is
 * (system errors used to reach the screen as "Error: os error 2" or a full file path).
 */
const PLAIN: [RegExp, string][] = [
  [/vlc.*(not found|isn.t installed|could not be found|no such file)|(not found|couldn.t find).*vlc/i, 'VLC isn’t installed or couldn’t be found. Install VLC, or use the built-in player.'],
  [/file not found|no such file|cannot find the (file|path)|os error 2\b|os error 3\b/i, 'The file couldn’t be found. If it’s on an external drive or a network share, check that it’s connected.'],
  [/permission denied|access is denied|os error 5\b|not permitted/i, 'TruongFlix isn’t allowed to use that file or folder. Check its permissions and try again.'],
  [/already exists|os error 17\b|os error 183\b/i, 'Something with that name is already there.'],
  [/no space left|disk (is )?full|os error 28\b|os error 112\b/i, 'The drive is full. Free up some space and try again.'],
  [/timed? ?out|deadline has elapsed/i, 'That took too long to respond. Try again in a moment.'],
  [/failed to fetch|networkerror|network error|error sending request|connection (refused|reset)|dns error|os error 10061\b|os error 11001\b/i, 'Couldn’t connect. Check your connection and try again.'],
];

/** Readable text for anything thrown or rejected. */
export function errorMessage(error: unknown): string {
  const raw = (error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)).replace(/^(\w*Error|Error): /, '').trim();
  return PLAIN.find(([re]) => re.test(raw))?.[1] ?? raw;
}
