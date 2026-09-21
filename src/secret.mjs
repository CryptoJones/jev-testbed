import { execFileSync } from 'node:child_process';

// The TypeSafe key lives in the gopass store at `typesafe/api-key`. That store is
// gpg-backed and only decryptable from Git Bash (where Git's gpg is on PATH), so
// when the key isn't already in the environment we shell out to Git Bash to read
// it. The key is never written to disk in this repo or hard-coded here.
const GIT_BASH = process.env.GIT_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe';
const PASS_ENTRY = process.env.TYPESAFE_PASS_ENTRY || 'typesafe/api-key';

// Reference gopass by winget's stable launcher so PATH state doesn't matter; Git's
// gpg is always on the login-shell PATH (/usr/bin), so gopass can decrypt.
const READ_CMD =
  `gp="$HOME/AppData/Local/Microsoft/WinGet/Links/gopass.exe"; ` +
  `command -v gopass >/dev/null 2>&1 && gp=gopass; ` +
  `"$gp" show -o ${PASS_ENTRY}`;

export function loadApiKey() {
  const fromEnv = process.env.TYPESAFE_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  try {
    const out = execFileSync(GIT_BASH, ['-lc', READ_CMD], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const key = out.trim();
    if (key) return key;
  } catch {
    // fall through to the actionable error below
  }

  throw new Error(
    `No TypeSafe API key found.\n` +
      `  - Set TYPESAFE_API_KEY in the environment, or\n` +
      `  - Store it once from Git Bash:  pass insert ${PASS_ENTRY}`
  );
}
