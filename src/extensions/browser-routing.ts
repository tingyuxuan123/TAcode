/** Browser routing guard for common launchers, not a general shell security parser. */
export function externalBrowserRequested(prompt: string): boolean {
  const browser = "(?:(?:外部|系统(?:默认)?|默认)(?:的)?浏览器|(?:Google\\s+)?Chrome|Safari|Firefox|(?:Microsoft\\s+)?Edge|(?:external|system|default)\\s+browser)";
  const request = new RegExp(`(?:(?:用|使用|通过|打开|启动|切换到)\\s*${browser}|在\\s*${browser}\\s*(?:中|里)?\\s*(?:打开|访问|查看|预览)|\\b(?:use|using|with|in|launch|open)\\s+(?:the\\s+)?${browser}\\b)`, "i");
  return prompt.split(/[，。！？；\n]|,\s+|;\s+|\bbut\b|但是|而是/i).some((clause) => {
    if (/不要|不想|不用|不使用|别|禁止|无需|为什么|为何|怎么|\b(?:not|never|why|how|without)\b|don['’]t|instead of/i.test(clause)) return false;
    if (/Chrome\s*(?:文档|官网|兼容|docs|documentation)/i.test(clause)) return false;
    return request.test(clause);
  });
}

/** Keep quoted strings together, so documentation/echo containing "open URL" is not executed syntax. */
function shellCommands(source: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quoted = "";
  let started = false;
  const pushWord = () => { if (started) words.push(word); word = ""; started = false; };
  const pushCommand = () => { pushWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === quoted) quoted = "";
      else if (char === "\\" && quoted === '"' && /["\\$`]/.test(source[index + 1] ?? "")) word += source[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quoted = char; started = true; continue; }
    if (char === "#" && !started) {
      while (index < source.length && source[index] !== "\n") index++;
      pushCommand();
    } else if (/[;&|\n]/.test(char)) pushCommand();
    else if (/\s/.test(char)) pushWord();
    else { word += char; started = true; }
  }
  pushCommand();
  return commands;
}

const webTarget = (word: string) => /^(?:https?:\/\/|about:blank$|localhost(?::\d+)?(?:[/?#]|$))/i.test(word);
const executableName = (word: string) => word.replaceAll("\\", "/").split("/").at(-1)!.replace(/\.exe$/i, "").toLowerCase();

export function externalBrowserCommand(command: string, depth = 0): boolean {
  if (depth > 3) return false;
  return shellCommands(command).some((words) => {
    let start = 0;
    while (start < words.length && (/^[\w]+=.*/.test(words[start]) || ["env", "command", "exec", "nohup"].includes(words[start]))) start++;
    if (start >= words.length) return false;
    const executable = executableName(words[start]);
    const args = words.slice(start + 1);
    const hasUrl = args.some(webTarget);
    if (["open", "xdg-open", "sensible-browser", "start", "start-process", "chrome", "google-chrome", "chromium", "firefox", "safari", "msedge"].includes(executable)) return hasUrl;
    if (executable === "gio") return args[0] === "open" && hasUrl;
    if (executable === "cmd" && /^\/c$/i.test(args[0] ?? "")) return externalBrowserCommand(args.slice(1).join(" "), depth + 1);
    if (["sh", "bash", "zsh", "powershell", "pwsh"].includes(executable)) {
      const flag = args.findIndex((arg) => /^-(?:[il]*c|command)$/i.test(arg));
      return flag >= 0 && externalBrowserCommand(args[flag + 1] ?? "", depth + 1);
    }
    if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable)) return args[0] === "-m" && args[1] === "webbrowser" && hasUrl;
    if (["npm", "pnpm", "yarn", "bun", "npx", "vite", "webpack"].includes(executable)) {
      const devCommand = executable === "vite" || executable === "webpack" || args.some((arg) => /^(?:dev(?::[\w-]+)?|start|serve|vite|webpack)$/.test(arg));
      return devCommand && args.some((arg) => arg === "--open" || /^--open=(?!false$)/.test(arg));
    }
    return false;
  });
}

export function browserRoutingBlock(toolName: string | undefined, input: { cmd?: string; command?: string } | undefined, prompt: string) {
  if (toolName !== "exec_command" || externalBrowserRequested(prompt)) return;
  const command = input?.cmd ?? input?.command;
  if (typeof command !== "string" || !externalBrowserCommand(command)) return;
  return {
    block: true,
    reason: "Tether 默认在内嵌浏览器打开网页。此命令会启动系统外部浏览器，已阻止执行。请改用 browser_navigate({url: 实际访问地址})。开发服务器只负责启动，去掉 --open 等自动打开参数；确认端口和路径后再调用 browser_navigate。不要重复使用系统 open/xdg-open/start，也不要声称网页已经打开。只有用户明确指定外部浏览器时才使用系统启动器。",
  };
}
