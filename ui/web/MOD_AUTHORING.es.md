# Tutorial de creación de mods de EveJS (punto de vista del autor)

> Para quienes **quieren hacer un mod**: de cero a un mod instalable desde el mercado de mods, en **8 pasos**.
> Durante todo el proceso **no hace falta modificar ningún archivo del servidor** — los mods se montan a través del loader.

**Lo que necesitas**: Windows 10+, un servidor EveJS (0.12.8 o superior), el lanzador EvEJS 0.1.20+ y una cuenta de GitHub.

---

## 🎨 Leyenda de colores / marcas (lee esto primero)

| Marca | Significado | Qué debes hacer |
| --- | --- | --- |
| 🟥 **Peligro** | Fallará, dará error o tendrá consecuencias **irreversibles** | No lo hagas nunca |
| 🟨 **Atención** | Es fácil equivocarse o el resultado no será el esperado | Compruébalo una vez antes de actuar |
| 🟦 **Consejo** | Un truco que ahorra tiempo | Puedes usarlo |
| 🟩 **Recomendado** | Conviene hacerlo así | Síguelo |
| ✅ **Obligatorio** | Sin esto no se puede continuar | Hay que hacerlo |
| ⭕ **Opcional** | Puede quedarse vacío | Según necesidad |
| 🧩 **Ejemplo** | Código / configuración para copiar tal cual | Cópialo y adáptalo |

> El Markdown de GitHub, la vista previa de VS Code, Typora, etc. muestran correctamente estas marcas de color (son emoji, **no hace falta ningún complemento**).

---

## 📋 Resumen de pasos

| # | Paso | Dónde | Tiempo aproximado | ¿Obligatorio? |
| --- | --- | --- | --- | --- |
| 1 | Comprobar el entorno (versión / carpeta mods) | Lanzador | 2 minutos | ✅ |
| 2 | Crear la **identidad de autor** y exportar `.eve-key` | Lanzador | 2 minutos | ✅ |
| 3 | Crear un **token de GitHub** (classic, marcar public_repo) | Web de GitHub | 5 minutos | ✅ (necesario para publicar y para enviar) |
| 4 | **Crear el mod** (generar el esqueleto) | Lanzador | 3 minutos | ✅ |
| 5 | Escribir tu lógica (`loader.js`) | Editor | Según necesidad | ✅ |
| 6 | Prueba local (activar / mirar registros) | Lanzador | 5 minutos | 🟩 Recomendado |
| 7 | **Publicar y subir al mercado** (empaquetar → subir a tu repositorio → abrir la PR de revisión, con un clic) | Lanzador | 1 minuto | ✅ |
| 8 | Publicar una versión nueva (cambiar el número de versión → pulsar «Publicar» otra vez) | Lanzador | 1 minuto | 🟩 Recomendado |

> 🟦 **Una sola vez vs. cada vez**: los pasos 1–4 se hacen una sola vez; después, cada versión pasa solo por el **paso 7** (empaquetado, subida al repositorio y PR de revisión en una sola operación, ver la parte 3).

---

# Parte 1: preparación (una sola vez)

## Paso 1 ✅ Comprobar el entorno

1. Abre el lanzador → **autocomprobación del entorno**: 9 puntos (Node.js / dependencias / ruta del cliente, etc.). Resuelve primero los que estén en rojo.
2. Comprueba la raíz del servidor EveJS (contiene `server/`, `config/`). En el lanzador → **centro de configuración** se ve la ruta que se está usando.
3. Comprueba que existe la carpeta **`mods/`**. Si no existe, en Mods / plugins → **crear mods/ automáticamente**.

🟨 **Atención**: la carpeta de mods es fija: `<raíz de EveJS>/mods/<ID del mod>/`. **No la pongas** en otro sitio ni la renombres con caracteres no ASCII.

---

## Paso 2 ✅ Crear la identidad de autor (la prueba de «quién eres»)

Mods / plugins → arriba, **configuración de tokens** (identidad de autor y token de GitHub en la misma ventana):

1. **Al abrirla por primera vez se genera automáticamente tu par de claves Ed25519** (no hay que pulsar ningún botón)
2. Cambia el **nombre para mostrar** (el nombre visible, por ejemplo «Comandante») → **guardar nombre para mostrar**
3. Pulsa **exportar clave** → guarda el archivo `.eve-key` **en un lugar seguro** (memoria USB / gestor de contraseñas)
4. Para cambiar de ordenador: en la máquina nueva pulsa **importar clave** y elige ese `.eve-key`; la identidad se restaura
5. El botón **carpeta de claves** abre directamente la carpeta de la clave privada (`_launcher/data/mod-keys/`)

Obtendrás tres cosas:

| Elemento | Descripción | ¿Hay que conservarlo? |
| --- | --- | --- |
| **ID de autor** (`au-...`) | Se escribe en el manifiesto del mod y significa «este mod es tuyo» | Se escribe automáticamente en el manifiesto |
| **Huella de clave** (`keyId`, 12 caracteres) | Sirve para verificar la firma | Se escribe automáticamente en el manifiesto |
| **Archivo `.eve-key`** | Dentro está la **clave privada** | 🟥 **Hay que conservarlo sin falta** |

🟥 **Peligro**:
- **`.eve-key` es tu identidad.** Si lo pierdes → **ya no podrás firmar ninguna actualización** (los usuarios antiguos verán «fallo de firma»); si se filtra → alguien podrá publicar haciéndose pasar por ti.
- **Nunca** subas `.eve-key` ni `_launcher/data/mod-keys/*.key` a GitHub, se los envíes a nadie ni los metas en un ZIP.

🟩 **Recomendado**: al cambiar de ordenador, recupera el `.eve-key` con «importar clave» y la identidad vuelve.

---

## Paso 3 ✅ Crear un token de GitHub (necesario para publicar y para enviar)

El lanzador actúa en GitHub por ti: al **publicar** escribe archivos en tu propio repositorio, crea la Release y sube el ZIP; al **solicitar la inclusión** crea un fork del repositorio índice `diguo520/EVEjs-mods` (propiedad del mantenedor) y abre una PR. Un **token classic** cubre ambas cosas.

### 3.1 Abrir la página correcta 🟨

```
GitHub, avatar arriba a la derecha → Settings → en la columna izquierda, abajo del todo, Developer settings
  → Personal access tokens → Tokens (classic) → Generate new token (classic)
```

Sigue la imagen de abajo (los números corresponden a los círculos rojos de la página):

![Página del token classic de GitHub: ① Tokens (classic) ② Generate new token (classic) ③ Note ④ Expiration ⑤ marcar repo](./github-token-classic.png)

| N.º | Dónde pulsar / qué escribir |
| --- | --- |
| ① | Columna izquierda **Tokens (classic)** — no «Fine-grained tokens» de arriba |
| ② | **Generate new token** → **Generate new token (classic)** |
| ③ | **Note**: lo que quieras, por ejemplo `evejs-launcher` |
| ④ | **Expiration**: se recomiendan 90 días (al caducar hay que regenerarlo) |
| ⑤ | En **Select scopes** marca **repo** (`public_repo` es un subelemento; con repo queda incluido) |

🟥 **No uses un token fine-grained**: su «Repository access» solo permite elegir repositorios sobre los que ya tienes permisos, no el repositorio índice `EVEjs-mods` del mantenedor; y crear el fork y abrir la PR exige permisos de escritura en ese repositorio. Con un token fine-grained, el envío fallará siempre con `403 Resource not accessible by personal access token`.

### 3.2 Rellenar los datos básicos

| Campo | Qué poner |
| --- | --- |
| Note | Lo que quieras, por ejemplo `evejs-launcher` |
| Expiration | 90 días recomendados o personalizado (al caducar hay que regenerarlo) |

### 3.3 Marcar los scopes (lo importante) 🟨

| scope | ¿Marcar? | Para qué sirve |
| --- | --- | --- |
| **public_repo** | 🟩 Obligatorio | Lectura/escritura de repositorios públicos: crear la Release, subir el ZIP, crear el fork y abrir la PR dependen de él |
| **repo** | 🟨 Recomendado | Incluye public_repo; márcalo si además quieres que el lanzador cree repositorios o gestione repositorios privados |

### 3.4 Generar y copiar

Pulsa **Generate token** → copia la cadena `ghp_...` (🟨 **solo se muestra una vez**; al cerrar la página ya no se ve).

### 3.5 Introducirlo en el lanzador

Mods / plugins → **configuración de tokens** → busca el token de GitHub → pega → **guardar** (se cifra en local; al guardar se verifican los permisos automáticamente) → si la verificación pasa, listo.

> 🟦 **¿Por qué classic?** El repositorio índice es del mantenedor y un token fine-grained no llega a él. Solo quienes hayan sido añadidos como **colaboradores del repositorio índice** pueden usar un token fine-grained: selecciona `EVEJS-mods` en Repository access y activa **Contents = Read and write** y **Pull requests = Read and write**.

🟨 **Atención**: después de cambiar los scopes o regenerar el token, **vuelve a pegar y guardar** el token nuevo.

---

# Parte 2: hacer un mod

## Paso 4 ✅ Crear el mod (generar el esqueleto)

Mods / plugins → **crear mod**, rellena el formulario:

| Campo | Obligatorio | Descripción |
| --- | --- | --- |
| Plantilla | ✅ | `Welcome Broadcast (Example)` (ejemplo con mensaje de bienvenida al entrar) / `Blank Skeleton` (esqueleto vacío). 🟩 La primera vez conviene empezar con el ejemplo |
| Nombre del mod | ✅ | El nombre que verán los jugadores |
| ID (id / nombre de carpeta) | 🟩 | Se genera automáticamente a partir del nombre; solo se permiten `a-z 0-9 - _ .`; tras crearlo **no lo cambies** |
| Versión | ✅ | Por defecto `1.0.0`; para una versión nueva hay que **subirla** (ver paso 8) |
| Categoría | ✅ | Jugabilidad / Economía / IA / Gráficos / Herramientas (el mercado filtra por esto) |
| Etiquetas | ⭕ | Separadas por comas, por ejemplo `chat, principiante` |
| Descripción | 🟩 | Una frase; aparece en la tarjeta del mercado |
| Descripción detallada / puntos clave | ⭕ | Se escriben en el README de tu mod |
| IDs de mods relacionados | ⭕ | Con qué mods se relaciona, separados por coma o espacio |
| Opciones de compilación | — | ☑ reiniciar el servidor (activado por defecto), ☑ activar justo después de crear (activado por defecto), ☑ firmar justo después de crear (activado por defecto) |

Al pulsar **Crear**, en tu carpeta `mods/` aparecerá:

```
mods/<id de tu mod>/
├─ evejs-launcher.mod.json    ← manifiesto (identidad, versión, categoría, dependencias)
├─ loader.js                  ← la lógica que escribes tú
├─ README.md                  ← generado desde «descripción detallada»
└─ CHANGELOG.md               ← historial de versiones
```

🟨 Solo si **desmarcas** «activar justo después de crear», `loader.js` se creará como `loader.js.disabled` (viene marcado, así que por defecto es un `loader.js` cargable). Para cambiarlo después, usa el interruptor de la pestaña **Instalados** — lo único que hace es renombrar el archivo.

🟨 **Campos obligatorios del manifiesto** (el lanzador los valida; si falta algo, verás «fallo de validación del manifiesto»):

```
schemaVersion: 3                       ← debe ser 3
id / displayName / version             ← ID / nombre / versión
kind: "loader"                         ← actualmente solo loader se puede activar de verdad
restart: "game_server"                 ← none | client | game_server | launcher
activation.strategy: "loader_rename"   ← obligatoriamente este valor
en la carpeta debe haber loader.js o loader.js.disabled
```

---

## Paso 5 ✅ Escribir tu lógica (`loader.js`)

Abre `mods/<id de tu mod>/loader.js`: ya viene un esqueleto — 🟩 **el propio esqueleto es un ejemplo mínimo que funciona** (el jugador recibe un mensaje en el chat local 10 segundos después de entrar). Modifícalo a tu gusto.

🟥 **Cuatro reglas estrictas** (están todas en el esqueleto; si quitas cualquiera, algo fallará):

| Regla | Por qué |
| --- | --- |
| `setImmediate` + comprobación de entrada (`process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world"`, o que la entrada sea `index.js`) | `NODE_OPTIONS` se hereda de npm hasta el servidor capa por capa, y cada proceso envoltorio carga tu archivo; sin la comprobación trabajarás en el proceso equivocado |
| **No `require` directamente los módulos grandes del servidor** (`chatHub` levanta unos 456 MB / 645 módulos) | Espera a que aparezca en `require.cache` y entonces toma la referencia: acierto de caché y cero memoria extra |
| `timer.unref()` | Evita que el temporizador impida terminar el proceso |
| Usar `globalThis.__xxx` para «instalar una sola vez» | El loader se carga varias veces; si no, se duplican mensajes y se acumulan escuchadores |

🟨 **Regla de rutas (la trampa más habitual)**: dentro del loader, `require("./src/...")` se resuelve **respecto a TU carpeta de mod**, **no** a la raíz del servidor — escrito así obtendrás `MODULE_NOT_FOUND`. Lo correcto es calcular primero la raíz del servidor:

```js
const path = require("path");
const serverRoot = path.resolve(__dirname, "..", "..", "server");
const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
// 🟨 No hagas require aquí directamente — espera a que el servidor lo haya cargado; ejemplo completo en el apéndice B
```

🟨 **Atributos de sesión**: los atributos personalizados de una sesión de chat **no se sincronizan automáticamente**; leerlos o escribirlos directamente puede «fallar en silencio». Usa las interfaces que ofrecen `chatHub` / `sessionRegistry`.

🟩 Los mods que necesitan **modificar el código del servidor** (y no solo llamar a sus API) están en el **apéndice G** — no enganches tú mismo `Module.prototype._compile`.

---

## Paso 6 🟩 Prueba local

1. Mods / plugins → **Instalados** → busca tu mod → enciende el interruptor (o marca «activar inmediatamente» al crearlo)
2. Lanzador → consola → **inicio con un clic** (levanta el servidor principal y el servicio de mercado)
3. Entra al juego y comprueba el efecto
4. Si algo va mal, mira dos registros:
   - Lanzador → **registro del servidor** (filtrable por Sistema / servidor principal / servicio de mercado / cliente y por INFO/WARN/ERROR)
   - Salida de la consola del servidor (visible en el lanzador)
5. 🟩 **Comprobar «si se cargó de verdad y cuánto tardó»**: busca `[EveJS-MOD]` en la salida del servidor:
   - `loader listo <tu mod> 3ms` — tu loader se cargó; `loader fallo ... :: <motivo>` significa que no se cargó
   - `loaders-done total=14 failed=0 ms=1086` — tiempo total de carga de todos los mods
   - `<archivo> inyectadas N capas (A -> B bytes)` — el parche del bus surtió efecto
   - `<id> parche fallido, se conserva el resultado de la capa anterior: <motivo>` — esta capa se omitió (**no** afecta a otros mods)

   🟨 El detalle por proceso y por capa también se escribe en `_launcher/logs/mod-load-report.json`: míralo directamente cuando quieras saber «quién cambió el archivo».

### 🔧 Guía rápida de problemas

| Síntoma | Causa más probable |
| --- | --- |
| En la lista pone «falta loader.js» | El archivo se borró o se renombró |
| El interruptor se apaga solo | Fallo de validación del manifiesto / la firma se modificó → mira el aviso rojo de la tarjeta |
| En el registro no aparece «cargando mod» | El mod está **desactivado** o se omitió por un conflicto |
| En el registro aparece `MODULE_NOT_FOUND` | `require("./src/...")` se resolvió respecto a la raíz del servidor — en realidad es relativo a tu carpeta de mod (ver paso 5) |
| En el juego no pasa nada y el registro no da error | La lógica hace `return` antes de la comprobación «instalar una sola vez», o la ruta del `require` es incorrecta |
| La memoria de Node se dispara | Se hizo `require` de un módulo grande del servidor (trampa 2 del paso 5) |

---

# Parte 3: publicar en el mercado

> **Publicar es un clic**: el lanzador encadena «volver a firmar → empaquetar el ZIP → subir a tu propio repositorio (crear el repositorio, crear la Release y subir el ZIP) → abrir una PR de revisión de versión al repositorio índice», y tú solo miras la barra de progreso.
> La PR al repositorio índice se abre **en cada versión** — solo cuando se fusiona, el mercado pasa a la versión nueva.

## Paso 7 ✅ Publicar y subir al mercado (un clic)

Mods / plugins → **publicar mod** (los botones «enviar a revisión / volver a enviar» de la tarjeta «Mis mods» abren la misma ventana):

1. **Elegir el mod**: en la lista **solo aparecen tus propios mods** (los de otros no salen, para evitar envíos por error)
2. Rellena el **número de versión** y las **notas de la actualización** (las notas van al índice y a la PR; escribe con palabras normales)
3. Comprueba **categoría / etiquetas**; **repositorio de origen / URL del proyecto** ⭕ opcional (por ejemplo `https://github.com/tu-usuario/tu-mod`), **enlace directo a GitHub Releases** ⭕ déjalo vacío (la dirección correcta se genera al publicar)
4. Marca las tres declaraciones (obra propia / sin código malicioso / reglas y condiciones leídas)
5. Pulsa **Publicar**

El botón «Publicar» solo se activa cuando se cumplen los requisitos de la parte superior: **nombre para mostrar** (paso 2), **token de GitHub** (paso 3), **30 minutos entre dos envíos del mismo mod**, **60 segundos entre dos publicaciones**. Lo que falte se marca en amarillo con un acceso para completarlo.

### Las cuatro fases del progreso

| Fase | Qué hace | Dónde |
| --- | --- | --- |
| Empaquetado local | Volver a firmar → empaquetar el ZIP → calcular el SHA256 → generar el manifiesto del mercado | **Solo en local**: sin red y sin token |
| Preparar tu repositorio de origen | Crea un repositorio público si no existe | Tu GitHub |
| Publicar la Release y subir el paquete | Escribe `evejs-mod.json` (lo que lee el mercado) → crea la Release (tag = `v<versión>`) → sube `<id>-<versión>.zip` | Tu GitHub |
| Abrir la PR de revisión de versión | PR al repositorio índice: la primera vez añade `sources.json` (registro), después solo actualiza `mods/<id>.json` en cada versión | Repositorio índice `diguo520/EVEjs-mods` |

Artefactos y registro:

| Artefacto | Ubicación |
| --- | --- |
| Paquete ZIP | `_launcher/temp/export-<id>-<version>.zip` (el mismo se sube a tu Release) |
| Registro de envíos | `_launcher/data/my-submissions.json` |

🟨 **Si cambias el código, pulsa «Publicar» otra vez**: en cuanto cambia el contenido, la firma deja de ser válida; el lanzador vuelve a firmar, a empaquetar y a subir una versión nueva.

### 🔧 Errores frecuentes en este paso

| Error | Causa | Solución |
| --- | --- | --- |
| 🟥 `403 Resource not accessible by personal access token` | El token es fine-grained, o classic sin public_repo | Usa un token classic con **public_repo**; el repositorio índice es del mantenedor y un token fine-grained no llega a él. Si ya eres colaborador del repositorio índice: token fine-grained con `EVEjs-mods` + Contents / Pull requests = Read and write |
| 🟥 `net::ERR_INVALID_ARGUMENT` | Fallo de subida del ZIP en lanzadores antiguos | Actualiza a **0.1.20+** |
| 🟥 `404` | El repositorio no existe o el token no lo cubre | Revisa la ortografía de owner/repo; usa un token classic (public_repo / repo) |
| 🟥 `token de GitHub sin rellenar` | Token no guardado | Vuelve al paso 3.5 |

🟩 **Después del éxito**: la ventana muestra la dirección del repositorio y de la Release (puedes abrirla para comprobar que el ZIP está ahí); la tarjeta pasa a **en revisión**.

### Revisión y fusión

- El mantenedor revisa tu mod en la PR (campos del manifiesto, categoría, ubicación del ZIP, número de versión, etc.)
- **Aceptada (fusionada)**: el CI del índice se reconstruye al momento, el mercado pasa a tu versión y todos los lanzadores pueden encontrarla
- **Rechazada**: el mantenedor responde en la PR y, en **Mis mods**, la tarjeta se pone roja con el **motivo del rechazo**

🟨 **Un mismo mod solo puede enviarse cada 30 minutos como mínimo**: insistir duplicaría la Release y refrescaría la misma PR una y otra vez; la ventana indica el tiempo restante y hasta entonces el botón está gris.

🟦 Tras el envío, el lanzador **vuelve a comprobar** esa PR para confirmar que realmente se abrió y anota su número y estado en el registro:
la tarjeta de «Mis mods» muestra `en revisión / fusionada / PR cerrada` (este estado se revisa como máximo una vez cada 30 minutos, para no molestar a GitHub sin necesidad).

---

## Paso 8 🟩 Publicar una versión nueva (cambiar la versión → pulsar «Publicar» otra vez)

1. Cambia el número de versión: edita `"version"` en `mods/<id>/evejs-launcher.mod.json` (por ejemplo `1.0.1`)
   🟨 También puedes regenerarlo en **crear mod** con el mismo id — pero **no cambies el id**
2. Mods / plugins → **publicar mod** → elige tu mod → pon la versión y las notas → **Publicar**
   (mismo repositorio, nueva tag `v1.0.1`, nuevo ZIP `<id>-1.0.1.zip`; la misma rama `release/<id>` actualiza la PR)

🟨 **Por qué hay que subir la versión**: el mercado decide con el número de versión si «hay algo nuevo»; si no cambia, los lanzadores de los demás no avisarán de la actualización.

🟦 **Por qué el nombre del ZIP lleva la versión**: jsDelivr cachea las referencias de rama hasta unas 12 horas; un nombre de archivo nuevo no cae en la caché vieja.

---

# Parte 4: revisión, retirada y recuperación

## Qué revisa el mantenedor

| Punto de control | Requisito |
| --- | --- |
| Propiedad del repositorio | Debe ser tu propio repositorio |
| Integridad del manifiesto | `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` / `sizeBytes` / `sha256` (64 caracteres hex) / `downloadUrls[]` |
| Ubicación del ZIP | En **tu propia Release** (el repositorio índice no guarda binarios) |
| Categoría | Una de cinco: Jugabilidad / Economía / IA / Gráficos / Herramientas |
| Regla estricta de atribución | El `id` es por orden de llegada; `author.id` va ligado a la clave (cambiar de clave implica rechazo) |
| Parches del código del servidor | Los mods que modifican archivos del servidor deben usar `__evejsMods.register` (apéndice G); si enganchas tú mismo `Module.prototype._compile` te pedirán que lo cambies — varios mods con su propio hook se anulan entre sí |

## Dónde ver el resultado de la revisión

Lanzador → Mods / plugins → **Mis mods**:

| Estado de la tarjeta | Significado | Qué puedes hacer |
| --- | --- | --- |
| 🟩 En el mercado | Ya incluido | Publica una versión nueva |
| 🟨 Actualización disponible / local más reciente que el mercado | Tu versión local es más nueva | Sigue el paso 8 |
| 🟧 Retirado | Retirado por el mantenedor | La tarjeta indica el **motivo de la retirada**; corrígelo y pulsa **volver a enviar a revisión** |
| 🟥 Rechazado | No pasó la revisión | La tarjeta indica el **motivo del rechazo**; corrígelo y pulsa **volver a enviar a revisión** |
| ⬜ Solo local / pendiente de envío | Aún sin publicar | Sigue el paso 7 |

🟦 **Mis mods** solo muestra entradas en las que «el mod sigue existiendo en local o todavía se puede instalar desde el mercado»; al borrar la carpeta local, las entradas que solo eran historial de revisión se ocultan automáticamente (la barra de título avisa con «N ocultas»).

---

# Apéndice: puntos esenciales (🟥 con guardar este trozo es suficiente)

| # | Punto | Consecuencia |
| --- | --- | --- |
| 1 | 🟥 No envíes el mod de otro como si fuera tuyo (un `author.id` que no es el tuyo hace que el proceso principal lo rechace) | El envío falla |
| 2 | 🟥 `.eve-key` / clave privada: nunca compartirla, nunca subirla, nunca meterla en un ZIP | Robo de identidad o pérdida definitiva de la capacidad de actualizar |
| 3 | 🟥 No modifiques los archivos del servidor en disco | Tocar el `server/` de otro impide instalar y rompe en la primera actualización; para cambiar en memoria usa `__evejsMods.register` (apéndice G) |
| 4 | 🟥 No hagas `require` de los módulos grandes del servidor dentro del loader | La memoria de Node se dispara |
| 5 | 🟨 El número de versión solo puede subir | Los demás no reciben la actualización |
| 6 | 🟨 Si cambias el código, pulsa «Publicar» otra vez (volver a firmar, empaquetar y subir es automático) | Firma inválida / el mercado se queda con el paquete antiguo |
| 7 | 🟨 No cambies el `id` después de crearlo | En los usuarios antiguos se convierte en «desinstalar + instalar de nuevo» |
| 8 | 🟨 El nombre del ZIP debe llevar la versión | Si no, puede caer en la caché de la CDN y servir un paquete antiguo |
| 9 | 🟨 Usa solo las cinco categorías fijas | No aparecerá en los filtros del mercado |
| 10 | 🟦 El loader se instala una sola vez (comprobación con `globalThis`) | Si no, registros duplicados y mensajes repetidos |

---

# Apéndice A: tabla completa de campos del manifiesto (`evejs-launcher.mod.json`)

| Campo | Obligatorio | Tipo | Descripción |
| --- | --- | --- | --- |
| `schemaVersion` | ✅ | number | Fijo `3` |
| `id` | ✅ | string | ID del mod, ≤128 caracteres, sin separadores de ruta, se recomienda `a-z0-9-` |
| `displayName` | ✅ | string | Nombre visible, ≤100 caracteres |
| `version` | ✅ | string | Número de versión, ≤64 caracteres, por ejemplo `1.0.0` |
| `kind` | ✅ | string | `loader` (usable) / `settings` / `client-package` / `source-integrated` (versiones futuras) |
| `restart` | ✅ | string | `none` / `client` / `game_server` / `launcher` |
| `activation.strategy` | ✅ | string | `loader_rename` |
| `description` | ⭕ | string | Descripción, ≤1000 caracteres (se muestra en la tarjeta del mercado) |
| `category` | 🟩 | string | Jugabilidad / Economía / IA / Gráficos / Herramientas |
| `tags` | ⭕ | string[] | Etiquetas |
| `author` | ✅ | object | `{ id, name, keyId, publicKey }` (lo escribe el lanzador automáticamente) |
| `requires` / `loadAfter` / `loadBefore` / `conflicts` | ⭕ | string[] | Dependencias y conflictos (se escriben IDs de mods) |
| `compatibility.evejsVersions` | ⭕ | string[] | Versiones de EveJS compatibles, por ejemplo `["0.12.8"]` |
| `signature` | ✅ | object | Firma (la genera el lanzador automáticamente) |

# Apéndice B: un esqueleto de loader que funciona

Esta es la **versión reducida** del esqueleto que genera «crear mod» — están las cuatro reglas estrictas y funciona en cuanto lo adaptes (la versión completa con comentarios está en `mods/<id de tu mod>/loader.js`):

```js
"use strict";
const path = require("path");

const TAG = "[mi-mod]";
const MOD_ID = "my-mod";
const POLL_MS = 3000;
const GRACE_MS = 10000;                      // esperar esto tras entrar: la sesión debe estar lista antes
const MESSAGE = "¡Bienvenido de nuevo, piloto!";

// Abre este bloque si vas a modificar el código del servidor (mecanismo nuevo: avisar al bus, solo añadir):
//   target —— relativo a la raíz de EveJS, con barras normales
//   marker —— marca única; si ya existe, el bus omite esa capa (idempotente)
//   slot   —— orden entre varias capas del mismo archivo, menor va antes (se recomiendan múltiplos de 10)
//   append —— solo código añadido, nunca reescribir el archivo entero
const SOURCE_PATCH = null;
// const SOURCE_PATCH = {
//   target: "server/src/network/tcp/handshake.js",
//   marker: "// my-mod:patch",
//   slot: 40,
//   append: "// my-mod:patch\nconsole.log('[my-mod] patched');",
// };

console.log(TAG + " preload ejecutado · pid=" + process.pid);

/** Continuar solo en el proceso real del servidor (excluye npm / procesos envoltorio) */
function isRealServerProcess() {
  if (process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world") return true;
  const entry = (require.main && require.main.filename) || process.argv[1] || "";
  return /(^|[\\/])index\.js$/i.test(entry);
}

/** Registrar el parche de código en el bus de inyección (🟥 debe ejecutarse de forma síncrona, ver abajo) */
function registerSourcePatch() {
  if (!SOURCE_PATCH || !SOURCE_PATCH.target) return;
  const bus = globalThis.__evejsMods;
  if (!bus || !(Number(bus.api) >= 1)) {
    console.log(TAG + " lanzador antiguo sin bus de inyección, se omite el parche de código");
    return;
  }
  bus.register({
    id: MOD_ID,
    target: SOURCE_PATCH.target,
    marker: SOURCE_PATCH.marker,
    slot: SOURCE_PATCH.slot,
    apply: (source) => source + "\n" + SOURCE_PATCH.append + "\n",
  });
}
// 🟥 Registro síncrono: el servidor hace require de los archivos objetivo al arrancar,
//    registrarlo dentro de setImmediate llega tarde (el archivo ya está compilado y el parche no se aplica)
registerSourcePatch();

setImmediate(() => {
  if (!isRealServerProcess()) return;
  if (globalThis.__myModStarted) return;      // 🟨 se carga varias veces: instalar una sola vez
  globalThis.__myModStarted = true;
  start();
});

function start() {
  // 🟥 require("./src/...") es relativo a TU carpeta de mod, no a la raíz del servidor — calcula primero la raíz
  const serverRoot = path.resolve(__dirname, "..", "..", "server");
  const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
  const registryPath = path.join(serverRoot, "src", "services", "chat", "sessionRegistry.js");

  // 🟨 Espera a que el propio servidor tenga estos dos módulos en require.cache y entonces toma la
  //    referencia: acierto de caché, cero memoria extra y sin levantar antes el grafo de 456 MB
  const timer = setInterval(() => {
    if (!require.cache[require.resolve(hubPath)]) return;
    if (!require.cache[require.resolve(registryPath)]) return;
    clearInterval(timer);
    run(require(require.resolve(hubPath)), require(require.resolve(registryPath)));
  }, 500);
  timer.unref();
}

function run(chatHub, sessionRegistry) {
  const seen = new Set();
  const firstSeenAt = new Map();

  const timer = setInterval(() => {
    let sessions;
    try {
      sessions = sessionRegistry.getSessions() || [];
    } catch {
      return;
    }

    const now = Date.now();
    const online = new Set();

    for (const session of sessions) {
      const characterID = sessionRegistry.resolveSessionCharacterID(session);
      if (!characterID) continue;              // aún no está realmente en el juego, espera a la siguiente vuelta
      online.add(characterID);
      if (!firstSeenAt.has(characterID)) firstSeenAt.set(characterID, now);
      if (seen.has(characterID)) continue;
      if (now - firstSeenAt.get(characterID) < GRACE_MS) continue;

      try {
        // Algunas sesiones solo llevan charid en minúsculas: lo completamos para evitar el «envío silencioso»
        if (!Number(session.characterID || 0)) session.characterID = characterID;
        chatHub.sendSystemMessage(session, MESSAGE);
        seen.add(characterID);
        console.log(TAG + " mensaje enviado al personaje " + characterID);
      } catch (error) {
        console.log(TAG + " el personaje " + characterID + " aún no está listo, se reintentará: " + error.message);
      }
    }

    // Limpiar los personajes desconectados; volverán a dispararse al entrar de nuevo
    for (const id of Array.from(seen)) if (!online.has(id)) seen.delete(id);
    for (const id of Array.from(firstSeenAt.keys())) if (!online.has(id)) firstSeenAt.delete(id);
  }, POLL_MS);
  timer.unref();
}
```

🟨 Las interfaces del servidor usadas arriba están **comprobadas en la práctica**:

| Interfaz | Uso |
| --- | --- |
| `sessionRegistry.getSessions()` | Array de sesiones en línea (🟥 **no** `list()`, ese método no existe) |
| `sessionRegistry.resolveSessionCharacterID(session)` | Obtiene el ID del personaje (0 mientras no ha entrado al juego) |
| `chatHub.sendSystemMessage(session, "mensaje")` | Envía un mensaje de sistema en el canal local de ese personaje |

Las interfaces pueden cambiar según la versión de EveJS; guíate por las exportaciones reales de tu versión.

# Apéndice C: conflictos y orden de carga

| Tipo | Cómo se produce | Consecuencia |
| --- | --- | --- |
| Conflicto declarado | Los `conflicts` de los manifiestos se citan entre sí | Los dos mods no se activan a la vez |
| `id` duplicado | Dos manifiestos comparten el mismo `id` | Solo se carga uno |
| Módulo de servidor compartido | Varios loaders referencian el mismo módulo del servidor | Pueden influirse entre sí (el lanzador avisa) |
| Dependencia ausente | El mod de `requires` no está instalado | Ese mod no se carga |

🟦 Orden de carga: en **Instalados** puedes **arrastrar** las tarjetas, o pulsar el botón «⤓ mover al final» de la tarjeta. La lista se agrupa con los mods activados primero y los desactivados después, cada grupo en tu orden — desactivar un mod no obliga a reordenar nada y, al reactivarlo, vuelve a su sitio.
🟨 `loadAfter` / `loadBefore` del manifiesto **tienen más prioridad** y ajustan el orden que arrastraste; un mod desplazado se marca como «movido por una restricción del manifiesto» en el panel Orden de carga.
🟦 El panel Orden de carga muestra el orden que **realmente se aplica**, además de los mods que **no se cargarán** esta vez (manifiesto inválido / falta una dependencia / conflicto / sin loader.js) y las declaraciones **sin efecto** (destino no instalado o desactivado, carpeta desaparecida del orden guardado). Reinicia el servidor para aplicarlo.

## 🟥 Varios mods modifican el mismo archivo del servidor (el lanzador nuevo tiene solución)

Si un mod **engancha por su cuenta `Module.prototype._compile`** para modificar el código del servidor, con dos mods sobre el mismo archivo surgen problemas:

- quién ve antes el archivo original depende por completo del orden de carga;
- si uno valida con el «sha256 del archivo entero», **fallará** porque el otro ya ha añadido contenido;
- el caso observado en la práctica: `minería automática` y `bloqueo y fuego automáticos` añadían ambos código al final de `server/src/network/tcp/handshake.js`; el que se inyectó primero escribía y el segundo veía un hash distinto y **se rendía en silencio** (sin error y sin efecto).

🟩 El lanzador nuevo ofrece para esto un **bus de inyección**: los mods ya no enganchan cada uno su hook, sino que declaran con `__evejsMods.register` «qué archivo y qué añadir», y el bus encadena las capas por `(slot, orden de registro)` — cada capa ve el contenido **ya modificado por la anterior**. El uso está en el **apéndice G**.

# Apéndice D: estructura del ZIP y reglas de importación

### Estructura del ZIP (se admiten ambas, se recomienda la forma 2)

```text
Forma 1: manifiesto en la raíz          Forma 2: envuelto en una sola carpeta (recomendado)
my-mod.zip                          my-mod.zip
├── evejs-launcher.mod.json          └── my-mod/
├── loader.js.disabled                   ├── evejs-launcher.mod.json
└── README.md                            ├── loader.js.disabled
                                          └── README.md
```

El lanzador localiza la raíz del paquete automáticamente; un ZIP con **varios** paquetes de mods se rechaza (una importación cada vez).

### Reglas cuando otra persona importa tu ZIP

| Regla | Descripción |
| --- | --- |
| Ubicación de instalación | `<raíz de EveJS>/mods/<id del manifiesto>` (los caracteres no válidos del id se cambian por `-`) |
| Estado inicial | **Desactivado a la fuerza** (`loader.js` vuelve a `loader.js.disabled`); el usuario lo activa a mano |
| Conflicto de nombres | Ya existe una carpeta con el mismo nombre en `mods/` → se rechaza la importación con aviso |
| Falta el manifiesto | El ZIP no tiene `evejs-launcher.mod.json` → se rechaza |

### 🟨 Tamaño

La página de mods **calcula de forma recursiva el espacio que ocupa cada mod**. Empaqueta solo los archivos necesarios — 🟥 no metas en el ZIP el repositorio de origen, `node_modules`, capturas de pantalla ni `.git`.

# Apéndice E: cómo se inyecta el loader

🟩 **Ahora (a través del bus de inyección)**: el lanzador pone **una sola** línea `--require "<mod-host.js incluido en el lanzador>"` en `NODE_OPTIONS`, y el bus hace `require` de tu `loader.js` en el orden de `_launcher/mods/mod-plan.json`. Por eso el nombre de la carpeta del mod puede llevar caracteres no ASCII o espacios; en el registro del lanzador, `[EveJS-MOD] loaders-done total=N failed=0 ms=X` es «cuántos milisegundos ha tardado la carga de todos los mods».

🟨 **Lo siguiente es la forma antigua de «un `--require` por loader»** (hoy solo se usa como red de seguridad si falla la escritura del plan del bus): el lanzador inyecta tu `loader.js` en el proceso del servidor mediante `NODE_OPTIONS=--require ...` de Node. Por tanto:

- 🟥 **Las barras invertidas se comen como escapes** → `C:\mods\x\loader.js` se convierte en `C:modsxloader.js`
- 🟨 `NODE_OPTIONS` se divide por espacios, así que **las rutas con espacios deben ir entre comillas**

La forma correcta es «convertir las rutas a barras normales + envolverlas en comillas dobles»; así lo monta el propio lanzador (comprobado en la práctica):

```js
const requireArgs = paths.map((p) => '--require "' + p.replace(/\\/g, "/") + '"').join(" ");
```

🟦 **No** necesitas montar esto tú mismo — basta con saber que «en la carpeta del mod no debe haber caracteres no ASCII ni espacios» para poder cuadrarlo al depurar.

# Apéndice F: lista de comprobación antes de publicar

- [ ] El mod se activa y funciona en local (probado en el paso 6)
- [ ] Los mods que modifican el código del servidor usan `__evejsMods.register` (apéndice G) y no enganchan `_compile` por su cuenta
- [ ] En `evejs-launcher.mod.json` son correctos `id` / `version` / `category`
- [ ] El número de versión es **mayor que el de la versión anterior**
- [ ] `.eve-key` está respaldado (necesario para cambiar de ordenador)
- [ ] En `mods/<id>/` no hay claves privadas, ni tus rutas locales, ni otros datos privados
- [ ] Has pulsado **publicar mod**, han pasado las cuatro fases y el ZIP se puede descargar desde tu página de Release
- [ ] La PR de revisión de esta versión en el repositorio índice **se ha fusionado** (sin fusión = el mercado sigue en la versión anterior)


# Apéndice G: modificar el código del servidor — el bus de inyección `__evejsMods.register`

🟨 Solo los mods que **necesitan modificar el código del servidor** requieren esta parte. Un mod como «saludo al entrar», que solo llama a la API del servidor, se apaña con el apéndice B.

El bus lo inyecta el lanzador; en el lado del mod basta con declararlo al final del archivo:

```js
const bus = globalThis.__evejsMods;
if (bus && bus.api >= 1) {
  bus.register({
    id: "id de tu mod",                             // igual que el id del manifiesto, sirve de marca en el informe
    target: "server/src/network/tcp/handshake.js",  // relativo a la raíz de EveJS, barras normales
    marker: "MY_MOD_MARK",                         // marca única: si ya está inyectado, se omite (idempotente)
    slot: 10,                                      // orden entre varias capas del mismo archivo, menor va antes
    apply: (source) => source + "\n// MY_MOD_MARK\n// aquí va el código que quieres añadir\n",
  });
} else {
  // lanzador antiguo sin bus: se puede volver a un hook propio o simplemente no inyectar nada
}
```

Cuatro reglas (🟥 incumplir cualquiera deja a otros mods sin funcionar sin motivo aparente):

| Regla | Por qué |
| --- | --- |
| Usa solo `register`, **no** enganches tú mismo `Module.prototype._compile` | Un hook propio vuelve a la «disputa por el punto de inyección» y el bus tampoco ve tus cambios |
| `apply` **solo añade**; no reescribas ni borres el contenido existente | Las capas siguientes deben recibir tu resultado y seguir añadiendo |
| Usa una `marker` única que nadie más use | El bus decide con ella si ya se inyectó, así que reiniciar no apila capas |
| Si validas, comprueba el **prefijo anterior al cambio** (o la longitud), no el sha256 del archivo entero | Un hash completo nunca coincidirá en una cadena de varias capas: es encerrarte tú mismo |

🟩 Cómo leer el resultado: en el registro, `[EveJS-MOD] <archivo> inyectadas N capas (A -> B bytes)` significa que esa capa surtió efecto; `[EveJS-MOD] <id> parche fallido, se conserva el resultado de la capa anterior: <motivo>` significa que esa capa se omitió (**no** afecta a otros mods).

---

**Versión del documento**: se actualiza con las versiones del lanzador (sincronizada con `_launcher/mods/MOD_AUTHORING.es.md` del lanzador).
Si te encuentras con un caso que no aparece aquí, mira primero el **registro del servidor** del lanzador y los avisos rojos de las tarjetas, y luego pregunta al mantenedor con el registro.
