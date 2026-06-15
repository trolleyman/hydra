package session

// ring is a fixed-capacity byte buffer that retains only the most recently
// written bytes. It is used to hold terminal scrollback so a newly-attached
// client can be shown recent output.
type ring struct {
	buf  []byte
	size int  // number of valid bytes currently stored
	cap  int  // capacity
	full bool // whether buf has wrapped
	pos  int  // next write index
}

func newRing(capacity int) *ring {
	if capacity <= 0 {
		capacity = 256 * 1024
	}
	return &ring{buf: make([]byte, capacity), cap: capacity}
}

// Write appends p, discarding the oldest bytes once capacity is exceeded.
func (r *ring) Write(p []byte) {
	if len(p) == 0 {
		return
	}
	// If the incoming chunk alone exceeds capacity, keep only its tail.
	if len(p) >= r.cap {
		copy(r.buf, p[len(p)-r.cap:])
		r.pos = 0
		r.full = true
		r.size = r.cap
		return
	}
	for len(p) > 0 {
		n := copy(r.buf[r.pos:], p)
		r.pos += n
		if r.pos == r.cap {
			r.pos = 0
			r.full = true
		}
		p = p[n:]
	}
	if r.full {
		r.size = r.cap
	} else {
		r.size = r.pos
	}
}

// Bytes returns a copy of the stored bytes in write order (oldest first).
func (r *ring) Bytes() []byte {
	if !r.full {
		out := make([]byte, r.pos)
		copy(out, r.buf[:r.pos])
		return out
	}
	out := make([]byte, r.cap)
	n := copy(out, r.buf[r.pos:])
	copy(out[n:], r.buf[:r.pos])
	return out
}
