// Health Copilot service worker: shows reminder notifications and handles their Taken / Snooze buttons.
// It does not cache pages, so a new release is always picked up on the next load.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Health Copilot', body: event.data ? event.data.text() : '' }
  }
  const options = {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    requireInteraction: Boolean(data.dose),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/', dose: data.dose || null },
    actions: data.dose ? data.actions || [] : [],
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Health Copilot', options))
})

self.addEventListener('notificationclick', (event) => {
  const { url, dose } = event.notification.data || {}
  event.notification.close()
  if (dose && (event.action === 'taken' || event.action === 'snooze')) {
    const body = { day: dose.day, time: dose.time, action: event.action === 'taken' ? 'taken' : 'snoozed', minutes: 15 }
    event.waitUntil(
      fetch(`/api/reminders/${dose.reminder_id}/doses`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(() => self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'dose-updated' })))),
    )
    return
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) {
          c.navigate(url || '/')
          return c.focus()
        }
      }
      return self.clients.openWindow(url || '/')
    }),
  )
})
