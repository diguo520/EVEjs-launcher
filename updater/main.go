package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	target := flag.String("target", "", "target launcher exe")
	source := flag.String("source", "", "downloaded new launcher exe")
	pid := flag.Int("pid", 0, "electron pid")
	parentPID := flag.Int("parent-pid", 0, "portable wrapper pid")
	restart := flag.Bool("restart", true, "restart target after update")
	from := flag.String("from", "", "previous version")
	to := flag.String("to", "", "new version")
	flag.Parse()

	logPath := filepath.Join(os.TempDir(), "EveJS-Launcher-Updater", "updater.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
	logger, _ := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	logf := func(format string, args ...any) {
		line := fmt.Sprintf("[%s] %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
		if logger != nil {
			_, _ = logger.WriteString(line)
		}
	}
	defer func() { _ = logger.Close() }()

	targetPath, err := filepath.Abs(strings.TrimSpace(*target))
	if err != nil || targetPath == "" {
		logf("invalid target: %v", err)
		os.Exit(2)
	}
	sourcePath, err := filepath.Abs(strings.TrimSpace(*source))
	if err != nil || sourcePath == "" {
		logf("invalid source: %v", err)
		os.Exit(2)
	}
	if _, err := os.Stat(sourcePath); err != nil {
		logf("source missing: %v", err)
		os.Exit(2)
	}
	waitPID(*pid, 60*time.Second, logf)
	waitPID(*parentPID, 60*time.Second, logf)
	time.Sleep(800 * time.Millisecond)

	targetDir := filepath.Dir(targetPath)
	newPath := targetPath + ".new"
	backupPath := targetPath + ".backup"
	_ = os.Remove(newPath)
	_ = os.Remove(backupPath)
	if err := copyFile(sourcePath, newPath); err != nil {
		logf("copy new exe failed: %v", err)
		os.Exit(3)
	}
	if err := os.Rename(targetPath, backupPath); err != nil {
		logf("backup old exe failed: %v", err)
		_ = os.Remove(newPath)
		os.Exit(4)
	}
	if err := os.Rename(newPath, targetPath); err != nil {
		logf("replace exe failed: %v", err)
		_ = os.Rename(backupPath, targetPath)
		_ = os.Remove(newPath)
		os.Exit(5)
	}
	// 更新完成后：如果原文件名里带旧版本号，就把文件改名成带新版本号的名字。
	// 否则用户看文件名会以为没有更新（界面里是新版本、文件名还是旧的）。
	finalPath := targetPath
	if *from != "" && *to != "" && *from != *to && strings.Contains(filepath.Base(targetPath), *from) {
		candidate := filepath.Join(targetDir, strings.Replace(filepath.Base(targetPath), *from, *to, 1))
		if candidate != targetPath {
			if err := os.Rename(targetPath, candidate); err == nil {
				finalPath = candidate
				logf("renamed updated exe to %s", finalPath)
			} else {
				logf("rename to versioned name failed: %v", err)
			}
		}
	}

	if *restart {
		args := []string{"--updated"}
		if *from != "" {
			args = append(args, "--from", *from)
		}
		cmd := exec.Command(finalPath, args...)
		cmd.Dir = targetDir
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
		if err := cmd.Start(); err != nil {
			logf("start new exe failed: %v", err)
			_ = os.Remove(targetPath)
			_ = os.Rename(backupPath, targetPath)
			_ = exec.Command(targetPath).Start()
			os.Exit(6)
		}
		_ = cmd.Process.Release()
	}
	time.Sleep(3 * time.Second)
	_ = os.Remove(backupPath)
	_ = os.Remove(sourcePath)
	logf("update complete: %s", finalPath)
}

func waitPID(pid int, timeout time.Duration, logf func(string, ...any)) {
	if pid <= 0 {
		return
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !pidRunning(pid) {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	logf("timeout waiting for pid %d", pid)
}

func pidRunning(pid int) bool {
	cmd := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/FO", "CSV", "/NH")
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), strconv.Itoa(pid))
}

func copyFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
