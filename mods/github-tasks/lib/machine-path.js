// A sh snippet that prints a path as the machine itself names it, so Herdr's file calls (readTextFile, writeTextFile with on)
// and the machine's programs resolve it alike: cygpath -m on Git Bash, MSYS2 or Cygwin (/tmp/x is C:/Users/…/Temp/x there),
// the path as it is elsewhere. ref: a quoted sh expression, such as "$HOME" or "$d". The sign-in (gh-sign-in.js) and runs/
// remote.js's Windows probe use it.
export const machinePath = (ref) => `if command -v cygpath >/dev/null 2>&1; then cygpath -m ${ref}; else printf '%s\\n' ${ref}; fi`;
