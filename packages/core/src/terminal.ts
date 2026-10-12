let input: AsyncIterator<string | Uint8Array> | undefined;
let queued = "";
let closed = false;

const nextCharacter = async (): Promise<string | undefined> => {
  // Bun before 1.4 drops the piped stdin that arrives between acquiring the
  // iterator and its first next, so it is acquired on the first read.
  input ??= process.stdin[Symbol.asyncIterator]();
  while (queued === "" && !closed) {
    // oxlint-disable-next-line no-await-in-loop
    const chunk = await input.next();
    if (chunk.done === true) {
      closed = true;
      break;
    }
    queued += String(chunk.value);
  }
  if (queued === "") {
    return undefined;
  }
  const character = queued.slice(0, 1);
  queued = queued.slice(1);
  return character;
};

const bracketedPasteStart = "\u001B[200~";
const bracketedPasteEnd = "\u001B[201~";

const readLine = async (): Promise<string> => {
  let value = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const character = await nextCharacter();
    if (character === undefined) {
      break;
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && queued.startsWith("\n")) {
        queued = queued.slice(1);
      }
      break;
    }
    value =
      character === "\u007F" || character === "\b"
        ? value.slice(0, -1)
        : `${value}${character}`;
  }
  return value
    .replaceAll(bracketedPasteStart, "")
    .replaceAll(bracketedPasteEnd, "")
    .trim();
};

export const readSecret = async (label: string): Promise<string> => {
  process.stderr.write(label);
  const raw = process.stdin.isTTY;
  if (raw) {
    process.stdin.setRawMode(true);
  }
  const value = await readLine();
  if (raw) {
    process.stdin.setRawMode(false);
  }
  process.stderr.write("\n");
  return value;
};

export const readAnswer = async (label: string): Promise<string> => {
  process.stderr.write(label);
  return await readLine();
};
