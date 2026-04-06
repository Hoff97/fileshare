/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { saveSharedFiles } from './shareTargetStore'

self.skipWaiting()
clientsClaim()
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

const navigationHandler = createHandlerBoundToURL('index.html')
registerRoute(new NavigationRoute(navigationHandler))

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'POST') {
    return
  }

  const url = new URL(event.request.url)

  if (!url.searchParams.has('share-target')) {
    return
  }

  event.respondWith((async () => {
    const formData = await event.request.formData()
    const files = formData.getAll('files').filter((value) => value instanceof File)

    await saveSharedFiles(files)

    const redirectUrl = new URL(url)
    redirectUrl.searchParams.set('share-target', '1')

    return Response.redirect(redirectUrl.toString(), 303)
  })())
})
