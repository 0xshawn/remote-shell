package main

import (
	"log"
	"strings"
)

var levelRank = map[string]int{"error": 0, "warn": 1, "info": 2, "debug": 3}

type leveledLogger struct{ level int }

func newLogger(level string) *leveledLogger {
	r, ok := levelRank[strings.ToLower(level)]
	if !ok {
		r = levelRank["info"]
	}
	return &leveledLogger{level: r}
}

func (l *leveledLogger) at(rank int, prefix, format string, a ...any) {
	if rank <= l.level {
		log.Printf(prefix+format, a...)
	}
}

func (l *leveledLogger) Errorf(f string, a ...any) { l.at(0, "[error] ", f, a...) }
func (l *leveledLogger) Warnf(f string, a ...any)  { l.at(1, "[warn] ", f, a...) }
func (l *leveledLogger) Infof(f string, a ...any)  { l.at(2, "[info] ", f, a...) }
func (l *leveledLogger) Debugf(f string, a ...any) { l.at(3, "[debug] ", f, a...) }
