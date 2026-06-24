package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// runUninstall tears down a binary install of remote-shell, best-effort. Every
// step ignores errors so a partial install still gets cleaned up as far as
// possible; permission failures print a hint to retry with sudo.
func runUninstall(args []string) {
	home, _ := os.UserHomeDir()
	if home == "" {
		home = "/"
	}
	stateDir := filepath.Join(home, ".remote-shell")

	if !hasYes(args) {
		fmt.Println("This will remove:")
		fmt.Println("  - the remote-shell systemd service (system and user scope)")
		fmt.Println("  - the remote-shell binary")
		fmt.Printf("  - %s\n", stateDir)
		fmt.Print("Continue? [y/N]: ")
		if !confirm() {
			fmt.Println("aborted")
			return
		}
	}

	var done []string

	// Stop and disable any systemd units, then drop the unit files.
	run("systemctl", "disable", "--now", "remote-shell")
	run("systemctl", "--user", "disable", "--now", "remote-shell")
	for _, unit := range []string{
		"/etc/systemd/system/remote-shell.service",
		filepath.Join(home, ".config", "systemd", "user", "remote-shell.service"),
	} {
		if removeFile(unit) {
			done = append(done, "removed "+unit)
		}
	}
	run("systemctl", "daemon-reload")
	run("systemctl", "--user", "daemon-reload")

	// Signal a still-running instance via its recorded pid.
	if pid := readPid(filepath.Join(stateDir, "remote-shell.pid")); pid > 0 {
		if syscall.Kill(pid, syscall.SIGTERM) == nil {
			done = append(done, fmt.Sprintf("sent SIGTERM to pid %d", pid))
		}
	}

	// Remove the binary from its known locations. Removing a running binary is
	// fine on Linux; the unlinked inode lives until the process exits.
	bins := map[string]struct{}{
		"/usr/local/bin/remote-shell":                        {},
		filepath.Join(home, ".local", "bin", "remote-shell"): {},
	}
	if self, err := os.Executable(); err == nil {
		bins[self] = struct{}{}
	}
	for bin := range bins {
		if removeFile(bin) {
			done = append(done, "removed "+bin)
		}
	}

	if err := os.RemoveAll(stateDir); err != nil {
		fmt.Printf("warning: could not remove %s: %v\n", stateDir, err)
	} else {
		done = append(done, "removed "+stateDir)
	}

	fmt.Println("uninstall complete:")
	if len(done) == 0 {
		fmt.Println("  (nothing found to remove)")
	}
	for _, d := range done {
		fmt.Println("  - " + d)
	}
}

// hasYes reports whether the args opt out of the confirmation prompt.
func hasYes(args []string) bool {
	for _, a := range args {
		switch a {
		case "-y", "--yes", "--force":
			return true
		}
	}
	return false
}

// confirm reads one line from stdin and reports whether it is an affirmative.
func confirm() bool {
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	}
	return false
}

// run executes a command best-effort, discarding output and errors.
func run(name string, args ...string) {
	_ = exec.Command(name, args...).Run()
}

// removeFile deletes path, returning true only when a file was actually
// removed. On permission errors it notes that sudo may be needed.
func removeFile(path string) bool {
	err := os.Remove(path)
	if err == nil {
		return true
	}
	if os.IsPermission(err) {
		fmt.Printf("warning: cannot remove %s (permission denied; try sudo)\n", path)
	}
	return false
}

// readPid reads and parses the pid stored in path, or 0 when unavailable.
func readPid(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0
	}
	return pid
}
