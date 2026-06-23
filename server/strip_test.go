package main

import "testing"

// TestStripQueries pins down which sequences are removed from replayed scrollback.
// Query sequences (which make xterm auto-reply) must go; everything that draws or
// only sets state must stay.
func TestStripQueries(t *testing.T) {
	const (
		esc = "\x1b"
		st  = esc + "\\"
		bel = "\x07"
	)
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"osc11 bg query (ST)", "a" + esc + "]11;?" + st + "b", "ab"},
		{"osc11 bg query (BEL)", "a" + esc + "]11;?" + bel + "b", "ab"},
		{"osc10 fg query", esc + "]10;?" + st, ""},
		{"osc4 palette query", "x" + esc + "]4;1;?" + bel + "y", "xy"},
		{"osc11 set is kept", esc + "]11;rgb:1e1e/1e1e/1e1e" + st, esc + "]11;rgb:1e1e/1e1e/1e1e" + st},
		{"osc0 title is kept", esc + "]0;my title" + bel, esc + "]0;my title" + bel},
		{"osc8 hyperlink with ? in url is kept", esc + "]8;;http://x/?q=1" + st + "link" + esc + "]8;;" + st,
			esc + "]8;;http://x/?q=1" + st + "link" + esc + "]8;;" + st},
		{"csi dsr cursor pos stripped", "a" + esc + "[6n" + "b", "ab"},
		{"csi dsr status stripped", esc + "[5n", ""},
		{"csi da primary stripped", "a" + esc + "[c" + "b", "ab"},
		{"csi da secondary stripped", esc + "[>c", ""},
		{"csi sgr color is kept", esc + "[31mred" + esc + "[0m", esc + "[31mred" + esc + "[0m"},
		{"csi cursor move is kept", esc + "[2J" + esc + "[H", esc + "[2J" + esc + "[H"},
		{"plain text untouched", "hello\r\nworld", "hello\r\nworld"},
		{"lone esc at end kept", "done" + esc, "done" + esc},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(stripQueries([]byte(tc.in))); got != tc.want {
				t.Fatalf("stripQueries(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
