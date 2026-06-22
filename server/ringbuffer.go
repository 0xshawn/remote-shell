package main

// ringBuffer is a fixed-capacity circular byte buffer. Once full, new writes
// overwrite the oldest bytes — this is the per-session scrollback that lets a
// reconnecting client repaint the screen without tmux.
//
// It is NOT internally synchronized: the owning session always touches it while
// holding session.mu, so an extra mutex here would only add lock churn.
type ringBuffer struct {
	buf  []byte
	head int // index of the oldest byte
	size int // number of valid bytes currently stored (<= len(buf))
}

func newRingBuffer(capacity int) *ringBuffer {
	if capacity < 1 {
		capacity = 1
	}
	return &ringBuffer{buf: make([]byte, capacity)}
}

// Write appends p, dropping the oldest bytes when the buffer is full.
func (r *ringBuffer) Write(p []byte) {
	c := len(r.buf)
	// If p alone is bigger than the whole buffer, only its tail can survive.
	if len(p) >= c {
		copy(r.buf, p[len(p)-c:])
		r.head = 0
		r.size = c
		return
	}
	tail := (r.head + r.size) % c // where the next byte goes
	first := c - tail
	if first > len(p) {
		first = len(p)
	}
	copy(r.buf[tail:tail+first], p[:first])
	if rem := len(p) - first; rem > 0 {
		copy(r.buf[:rem], p[first:])
	}
	if r.size+len(p) <= c {
		r.size += len(p)
	} else {
		over := r.size + len(p) - c
		r.head = (r.head + over) % c
		r.size = c
	}
}

// Snapshot returns a copy of the current contents, oldest byte first.
func (r *ringBuffer) Snapshot() []byte {
	out := make([]byte, r.size)
	c := len(r.buf)
	first := c - r.head
	if first > r.size {
		first = r.size
	}
	copy(out, r.buf[r.head:r.head+first])
	if r.size > first {
		copy(out[first:], r.buf[:r.size-first])
	}
	return out
}
