// A deadline that resets on activity, shared by both routes.
//
// A long generation is not a stuck one: the timer exists only while a read is
// outstanding, so a model that thinks for ten minutes and then answers is
// fine, while a connection that goes quiet is not.

/**
 * A deadline that resets on activity rather than bounding the whole stream.
 *
 * A long generation is not a stuck one: the timer exists only while a read is
 * outstanding, so a model that thinks for ten minutes and then answers is
 * fine, while a connection that goes quiet is not.
 *
 * @param {AbortSignal} upstream - caller and consumer cancellation.
 * @param {number} idleMs - budget between reads.
 * @returns {{signal: AbortSignal, pulse: () => void, next: (it: AsyncIterator<unknown>) => Promise<IteratorResult<unknown>>, dispose: () => void}}
 */
function idleWatchdog(upstream, idleMs) {
  const controller = new AbortController()
  let timer
  let timedOut = false
  const onUpstream = () => { controller.abort(upstream.reason) }
  if (upstream.aborted) controller.abort(upstream.reason)
  else upstream.addEventListener('abort', onUpstream, { once: true })

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const arm = () => {
    clear()
    timer = setTimeout(() => {
      timedOut = true
      controller.abort('idle timeout')
    }, idleMs)
    // A pending read must not hold the process open on its own.
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    pulse: arm,
    async next(iterator) {
      arm()
      try {
        return await iterator.next()
      } finally {
        clear()
      }
    },
    dispose() {
      clear()
      upstream.removeEventListener('abort', onUpstream)
    },
  }
}

module.exports = { idleWatchdog }
