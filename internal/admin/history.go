package admin

import (
	"sync"
	"time"
)

// How the trend is kept.
//
// Five seconds apart for half an hour, which is three hundred and sixty
// samples of six small numbers — a few kilobytes, and the answer to what just
// happened. Anything longer is a monitoring system arriving one requirement at
// a time, and this is not that: it answers the question somebody has while
// standing at the page, not what last Tuesday cost.
const (
	every = 5 * time.Second
	span  = 30 * time.Minute
	depth = int(span / every)
)

// A Sample is one moment.
type Sample struct {
	At time.Time `json:"at"`
	// Bytes per second, in and out, as the media server measured them over its
	// own window rather than as a difference computed here.
	In  float64 `json:"in"`
	Out float64 `json:"out"`
	// What was happening, so a spike can be read against it.
	Rooms   int32   `json:"rooms"`
	Clients int32   `json:"clients"`
	Nack    float32 `json:"nack"`
}

// History is the recent shape of the load.
//
// Kept in the server rather than in the page, and that is the whole design
// decision. A buffer in the browser starts empty on every load, so somebody
// opening this to find out what just happened would wait half an hour to be
// told. One buffer here means two administrators watching see the same picture
// and a reload keeps it.
//
// Lost on restart, like the sessions and the audit tail. Consistent with
// everything else this process remembers, which is nothing.
type History struct {
	mu      sync.Mutex
	samples []Sample
}

func NewHistory() *History {
	return &History{samples: make([]Sample, 0, depth)}
}

// Watch fills the history until the channel closes.
//
// Its own ticker rather than sampling when a page asks: a trend with gaps
// wherever nobody was looking is not a trend, and the first thing anybody would
// do with one is misread the gap as quiet.
func (h *History) Watch(stop <-chan struct{}, read func() Sample) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	h.add(read())

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			h.add(read())
		}
	}
}

func (h *History) add(sample Sample) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.samples = append(h.samples, sample)
	if len(h.samples) > depth {
		// Copied down rather than resliced, so the array does not keep hold of
		// the samples that fell off the end.
		h.samples = append(h.samples[:0], h.samples[len(h.samples)-depth:]...)
	}
}

// Since returns what is held, oldest first.
func (h *History) Since() []Sample {
	h.mu.Lock()
	defer h.mu.Unlock()

	out := make([]Sample, len(h.samples))
	copy(out, h.samples)

	return out
}
