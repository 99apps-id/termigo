import { describe, expect, it } from "vitest";
import { commandRisk, deletesFiles, isReadOnlyCommand } from "./commandRisk";

describe("inspection commands", () => {
  // These are the bulk of what an agent runs while working on a server, and
  // gating them is what turned review into reflex.
  it("recognises everyday inspection", () => {
    for (const c of [
      "ls -la /srv/app",
      "cat /etc/nginx/nginx.conf",
      "pwd",
      "df -h",
      "ps aux",
      "grep -rn TODO /srv",
      "tail -n 100 /var/log/syslog",
      "whoami",
      "uname -a",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(true);
    }
  });

  it("reads the verb for tools where it decides", () => {
    for (const c of [
      "git status",
      "git log --oneline -20",
      "docker ps -a",
      "docker logs myapp",
      "systemctl status nginx",
      "kubectl get pods",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(true);
    }
  });

  it("allows a pipeline of inspection commands", () => {
    expect(isReadOnlyCommand("ps aux | grep nginx | head -5")).toBe(true);
    expect(isReadOnlyCommand("cat access.log | wc -l")).toBe(true);
  });

  it("ignores an env prefix and a full path", () => {
    expect(isReadOnlyCommand("LC_ALL=C ls -la")).toBe(true);
    expect(isReadOnlyCommand("/usr/bin/cat /etc/hostname")).toBe(true);
  });
});

describe("commands that change something", () => {
  it("catches the obvious ones", () => {
    for (const c of [
      "rm -rf /srv/app",
      "apt install nginx",
      "systemctl restart nginx",
      "docker compose up -d",
      "mv a b",
      "chmod 777 /etc",
      "npm install",
      "git push",
      "git commit -m x",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(false);
    }
  });

  // One `&&` away from rm -rf is not an inspection command, however harmless
  // the first half looks.
  it("rejects a chain where any part changes something", () => {
    expect(isReadOnlyCommand("ls -la && rm -rf /tmp/x")).toBe(false);
    expect(isReadOnlyCommand("cat a.txt; systemctl restart nginx")).toBe(false);
    expect(isReadOnlyCommand("grep x f || apt install y")).toBe(false);
  });

  // find reads until -delete or -exec, at which point it runs anything.
  it("catches a read command turned destructive by a flag", () => {
    expect(isReadOnlyCommand("find /tmp -name '*.log' -delete")).toBe(false);
    expect(isReadOnlyCommand("find / -name x -exec rm {} ;")).toBe(false);
  });

  it("treats a redirection as a write, whatever produced the output", () => {
    expect(isReadOnlyCommand("cat a > b")).toBe(false);
    expect(isReadOnlyCommand("echo hi >> /etc/hosts")).toBe(false);
  });

  // Substitution can run anything, and proving otherwise is not worth the
  // analysis it would take.
  it("refuses command substitution", () => {
    expect(isReadOnlyCommand("echo $(rm -rf /)")).toBe(false);
    expect(isReadOnlyCommand("cat `whoami`")).toBe(false);
  });

  it("refuses anything asking for privileges", () => {
    expect(isReadOnlyCommand("sudo ls")).toBe(false);
    expect(isReadOnlyCommand("su -c ls")).toBe(false);
  });

  // Fail-closed is the whole design: being wrong in the permissive direction
  // is what this guards against.
  it("treats an unfamiliar command as changing something", () => {
    expect(isReadOnlyCommand("mysterious-binary --go")).toBe(false);
    expect(isReadOnlyCommand("./deploy.sh")).toBe(false);
    expect(isReadOnlyCommand("")).toBe(false);
  });

  it("treats an unknown subcommand of a known tool as changing something", () => {
    expect(isReadOnlyCommand("git reset --hard")).toBe(false);
    expect(isReadOnlyCommand("docker rm -f app")).toBe(false);
    expect(isReadOnlyCommand("systemctl stop nginx")).toBe(false);
  });
});

describe("commandRisk", () => {
  it("labels both sides", () => {
    expect(commandRisk("ls")).toBe("inspect");
    expect(commandRisk("rm -rf /")).toBe("change");
  });
});

// Deleting is the one action no approval mode delegates, so this classifier
// decides whether a shell command reaches that floor.
describe("deletesFiles", () => {
  it("catches the plain unix removers", () => {
    for (const c of [
      "rm file.txt",
      "rm -rf dist",
      "rmdir build",
      "unlink link",
      "shred -u secret.key",
    ]) {
      expect(deletesFiles(c)).toBe(true);
    }
  });

  it("catches the Windows and PowerShell spellings", () => {
    for (const c of [
      "del package-lock.json",
      "erase out.log",
      "rd /s /q node_modules",
      "Remove-Item -Recurse -Force dist",
      "ri temp.txt",
    ]) {
      expect(deletesFiles(c)).toBe(true);
    }
  });

  it("catches a delete hidden after a harmless first segment", () => {
    expect(deletesFiles("pnpm build && rm -rf dist")).toBe(true);
    expect(deletesFiles("ls; rm -rf src")).toBe(true);
    expect(deletesFiles("cat x | rm -rf y")).toBe(true);
  });

  it("catches git clean, which removes what git cannot give back", () => {
    expect(deletesFiles("git clean -fdx")).toBe(true);
    expect(deletesFiles("git status")).toBe(false);
  });

  it("catches find's own delete and exec routes", () => {
    expect(deletesFiles("find . -name '*.tmp' -delete")).toBe(true);
    expect(deletesFiles("find . -exec rm {} ;")).toBe(true);
  });

  it("catches a delete hidden in a command substitution", () => {
    expect(deletesFiles("echo $(rm -rf build)")).toBe(true);
  });

  it("leaves ordinary work alone", () => {
    for (const c of [
      "ls -la",
      "pnpm build",
      "git commit -m 'fix'",
      "systemctl restart nginx",
      "docker ps",
      "cargo test",
      "mv old.txt new.txt",
    ]) {
      expect(deletesFiles(c)).toBe(false);
    }
  });

  it("is not fooled by a word that merely contains a verb", () => {
    expect(deletesFiles("rmdirs-helper --check")).toBe(false);
    expect(deletesFiles("./format.sh")).toBe(false);
  });

  it("treats an empty command as nothing to gate", () => {
    expect(deletesFiles("")).toBe(false);
    expect(deletesFiles("   ")).toBe(false);
  });
});
