# HOOKtopus

Receptor de webhooks: da una URL, guarda los bytes exactos de cada petición, los enseña en directo y los reenvía a una URL pública (servidor) o a localhost (CLI `npx hooktopus`). Proyecto de backend para el portfolio (apvwbm.com), hermano de Sonda (`../sonda`), del que copia stack y patrones.

## Stack y comandos

Node ≥ 22.18 ejecutando `.ts` sin compilar · Fastify 5 · better-sqlite3 · zod 3 · `node:test` · front sin build en `public/`.

```sh
npm run dev        # servidor en :8080, lee .env
npm test           # typecheck + tests del servidor
cd cli && npm test # tests del CLI (paquete npm aparte, sin dependencias)
npm run build      # dist/ para producción
```

## Decisiones que no hay que deshacer

- **Bytes exactos:** el plugin de captura (`src/routes/capture.ts`) quita los parsers de Fastify **solo dentro de `/h`** y lee todo como Buffer. Las cabeceras salen de `rawHeaders`, no de `request.headers`.
- **Directo sin huecos:** en `src/routes/stream.ts`, la consulta de lo perdido y `hub.subscribe` van en el mismo tick síncrono. No meter un `await` entre medias. Los ids de `requests` son `AUTOINCREMENT` porque el stream reanuda por id.
- **SSRF:** la comprobación va en el `lookup` de `http.request` (`src/lib/guard.ts`); las IP literales se comprueban aparte porque Node no llama a `lookup` con ellas; no se siguen redirecciones. **No existe variable de entorno para desactivarla**, solo `deps.allowPrivateTargets` en `buildApp` para los tests.
- No añadir `::ffff:0:0/96` al `BlockList`: Node lo aplica también a IPv4 y bloquea todas las IPs públicas.
- Con cabeceras en array, `http.request` no añade `Host`: hay que ponerlo a mano (ya está en `src/lib/replay.ts`).
- Un solo proceso a propósito: el rate limit y el reparto del directo viven en memoria (comentarios `ponytail:`).
- Límites fijos en `src/limits.ts`; solo lo operativo va en variables de entorno (`.env.example`).

## Pendiente

- **Licencia:** sin elegir. Hace falta antes de publicar el CLI en npm (también falta `license` en `cli/package.json`).
- **Docker:** el `Dockerfile` no se ha construido nunca (no hay Docker en el PC). Probarlo en el homelab.
- **Despliegue:** `hooktopus.apvwbm.com` en el homelab, que está apagado por la mudanza. Detrás del proxy: `HOOKTOPUS_TRUST_PROXY=true`, sin buffering para SSE, timeout de lectura > 25 s, cuerpos ≥ 512 KB.
- **CLI en npm:** comprobar que `hooktopus` está libre (`npm view hooktopus`) y publicar cuando haya demo.
- **Portfolio:** añadir la entrada en `../apvwbm/src/data/proyectos.ts` copiando la estructura de la de Sonda. Las explicaciones largas de las decisiones van ahí, no en el README, que se dejó corto a propósito.
- **v2:** comprobar firmas (GitHub/Stripe), reintentos automáticos, respuestas configurables.

## Estilo

Código y README en inglés; comentarios que explican el porqué. Commits en castellano, los hace el usuario. Simplicidad por encima de todo: nada de abstracciones ni opciones que nadie usa.
