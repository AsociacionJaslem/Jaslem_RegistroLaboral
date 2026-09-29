# JÁSLEM — Registro de jornada laboral

Esta es una aplicación web para fichar entradas/salidas, gestionar
trabajadores y generar informes, sin necesitar Google Sheets. Funciona
con **Firestore** (la base de datos de Google) como almacén de datos y
**GitHub Pages** para publicar la página web — es gratis para una
organización de este tamaño.

Esta guía da por hecho que **no tienes experiencia técnica previa**.
Todo se hace **desde el navegador**, en las páginas web de Firebase y de
GitHub — **no hay que instalar ningún programa** (ni Git, ni Node.js, ni
nada parecido). Sigue los pasos en orden, uno a uno, sin saltarte
ninguno. Al final tendrás la aplicación funcionando con una dirección web
propia que podrás compartir con tus trabajadores.

---

## Antes de empezar

Necesitas tener:

1. Una cuenta de Google (la misma que uses para Gmail sirve).
2. Una cuenta de GitHub — si no tienes, créala gratis en
   <https://github.com/join> (solo pide un email, un nombre de usuario y
   una contraseña).
3. Un ordenador con conexión a internet y un navegador (Chrome, Edge o
   Firefox). Nada más — no hay que instalar nada.

No hace falta pagar nada. Todo lo usado en esta guía es gratuito.

---

## PARTE 1 — Crear la base de datos en Firebase

### Paso 1: Crear el proyecto

1. Entra en <https://console.firebase.google.com> con tu cuenta de
   Google.
2. Pulsa el botón **"Crear un proyecto"** (o **"Add project"** si te
   sale en inglés).
3. Ponle un nombre, por ejemplo `jaslem-jornada`. Firebase le añadirá
   automáticamente unos números para que sea único.
4. En la pantalla de Google Analytics, puedes pulsar **"No habilitar
   Google Analytics"** (no hace falta para esta app) y continuar.
5. Espera unos segundos a que Firebase cree el proyecto y pulsa
   **"Continuar"**.

### Paso 2: Activar la base de datos (Firestore)

1. En el menú de la izquierda, busca el apartado **"Compilación"** (o
   "Build") y dentro de él pulsa **"Firestore Database"**.
2. Pulsa el botón **"Crear base de datos"**.
3. Elige la ubicación — cualquiera de Europa está bien, por ejemplo
   `eur3 (europe-west)`. **Esto no se puede cambiar después**, así que
   elige con calma, pero cualquier opción europea funcionará bien.
4. En "Reglas de seguridad iniciales", elige **"Modo de producción"**
   (no "modo de prueba"). No te preocupes por escribir reglas ahora — más
   adelante en esta guía subiremos las reglas correctas ya preparadas.
5. Pulsa **"Habilitar"** y espera a que termine.

### Paso 3: Activar el inicio de sesión de administrador

1. En el menú de la izquierda, dentro de "Compilación", pulsa
   **"Authentication"**.
2. Pulsa **"Comenzar"** (o "Get started").
3. En la lista de formas de acceder, pulsa **"Correo electrónico/Contraseña"**.
4. Activa **los dos interruptores**: "Correo electrónico/contraseña" Y
   también **"Enlace de correo electrónico (sin contraseña)"**. Este
   segundo es imprescindible: es el que permite mandar la invitación por
   correo a los trabajadores para que elijan su código de 6 dígitos.
   Pulsa **"Guardar"**.
5. Ahora ve a la pestaña **"Users"** (o "Usuarios") de esa misma sección
   y pulsa **"Agregar usuario"**.
6. Escribe el email y la contraseña que usará **la primera persona
   administradora** de la app (puede ser tu propio email). Apunta bien
   estos datos, los necesitarás dentro de un momento.
7. Pulsa **"Agregar usuario"**. En la tabla aparecerá una fila con ese
   email y, en la columna "User UID", un código largo de letras y
   números (algo como `aB3dEfGh...`). **Copia ese código** — lo vas a
   necesitar en el Paso 4.

### Paso 4: Autorizar a esa persona como administradora

Esto se hace directamente en la base de datos, a mano, solo la primera
vez (después, las altas de trabajadores se hacen desde la propia app).

1. Vuelve a **"Firestore Database"** en el menú de la izquierda.
2. Pulsa **"Iniciar colección"**.
3. En "ID de colección" escribe exactamente: `administradores`
4. Pulsa "Siguiente".
5. En "ID del documento", **pega el código UID** que copiaste en el Paso
   3.7 (NO pulses "Autoidentificador" — tiene que ser exactamente ese
   código).
6. Añade un campo:
   - Nombre del campo: `nombre`
   - Tipo: `string` (cadena de texto)
   - Valor: el nombre de esa persona, por ejemplo `Ana (Administradora)`
7. Pulsa **"Guardar"**.

Ya tienes tu primer administrador. Repite este Paso 4 (con un nuevo
usuario del Paso 3) por cada persona más que quieras que pueda entrar
como administrador.

### Paso 5: Obtener la configuración de tu proyecto

1. Pulsa el icono del **engranaje** (⚙️), arriba a la izquierda, junto a
   "Descripción general del proyecto", y elige **"Configuración del
   proyecto"**.
2. Baja hasta la sección **"Tus apps"**.
3. Pulsa el icono `</>` (el de "Web").
4. Ponle un nombre a la app, por ejemplo `JASLEM Web`, y pulsa
   **"Registrar app"**. **No** hace falta marcar la casilla de Firebase
   Hosting.
5. Aparecerá un bloque de código con algo como esto:

   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "jaslem-jornada-xxxxx.firebaseapp.com",
     projectId: "jaslem-jornada-xxxxx",
     storageBucket: "jaslem-jornada-xxxxx.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef123456"
   };
   ```

   **Copia todo ese bloque** (o simplemente deja esta pestaña abierta,
   lo necesitarás en la Parte 3).
6. Pulsa **"Continuar en la consola"**.

---

## PARTE 2 — Subir el proyecto a GitHub (sin instalar nada)

### Paso 6: Crear el repositorio en GitHub

1. Entra en <https://github.com/new> (con tu cuenta de GitHub ya
   iniciada sesión).
2. En "Repository name" pon un nombre, por ejemplo `jaslem-jornada`.
3. Puedes dejarlo como "Public" (público) — no contiene ningún dato
   secreto, solo el código de la aplicación.
4. **No** marques ninguna casilla de "Add a README" ni ".gitignore".
5. Pulsa **"Create repository"**.

### Paso 7: Subir la carpeta "public"

Primero, descomprime en tu ordenador (por ejemplo, en el Escritorio) el
archivo `.zip` que te han dado, si no lo has hecho ya.

1. En la página de tu repositorio recién creado, busca el enlace azul
   que dice algo como **"subiendo un archivo existente"** (uploading an
   existing file) y púlsalo. Si no lo ves (por ejemplo, porque el
   repositorio ya no está vacío), pulsa el botón verde **"Añadir
   archivo"** (Add file) → **"Subir archivos"** (Upload files).
2. Abre, en el explorador de archivos de tu ordenador (Finder en Mac,
   Explorador de archivos en Windows), la carpeta del proyecto ya
   descomprimida.
3. Arrastra la carpeta **`public`** completa — la carpeta entera, con su
   nombre, no solo lo que hay dentro — hasta la zona de GitHub que dice
   "Arrastra los archivos aquí para añadirlos a tu repositorio" (Drag
   files here to add them to your repository). Espera a que termine de
   subir (puede tardar un poco por el logo).
4. Abajo del todo, en el recuadro de **"Confirmar cambios nuevos"**
   (Commit new files), puedes dejar el texto que aparece por defecto.
5. Pulsa el botón verde **"Confirmar cambios"** (Commit changes).
6. Comprueba que ha quedado bien: en tu repositorio debe aparecer una
   carpeta llamada `public` y, al entrar en ella, sus 5 archivos
   (`index.html`, `firestore-datos.js`, `logica-comun.js`,
   `informes-cliente.js`, `logo.png`).

### Paso 8: Crear el archivo que le dice a GitHub cómo publicar la web

Este archivo vive dentro de una carpeta llamada `.github`, que empieza
por un punto — los selectores de archivos del ordenador suelen
ocultarla, así que es más fácil crearla directamente en la web de
GitHub, escribiendo su ruta completa:

1. En tu repositorio, pulsa **"Añadir archivo"** (Add file) → **"Crear un archivo nuevo"** (Create new file).
2. En el campo del nombre del archivo (arriba del cuadro grande),
   escribe exactamente esto, con las barras incluidas:

   ```
   .github/workflows/pages.yml
   ```

   GitHub creará automáticamente las carpetas `.github` y `workflows` al
   escribir las barras.
3. En el cuadro grande de abajo, pega exactamente este contenido:

   ```yaml
   name: Publicar en GitHub Pages

   on:
     push:
       branches: [main]
     workflow_dispatch: {}

   permissions:
     contents: read
     pages: write
     id-token: write

   concurrency:
     group: pages
     cancel-in-progress: true

   jobs:
     publicar:
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       steps:
         - uses: actions/checkout@v4
         - uses: actions/configure-pages@v5
         - name: Preparar solo la carpeta "public" para publicarla
           uses: actions/upload-pages-artifact@v3
           with:
             path: public
         - name: Publicar
           id: deployment
           uses: actions/deploy-pages@v4
   ```

4. Baja hasta el final de la página y pulsa el botón verde **"Confirmar
   cambios nuevos..."** (Commit new file...), y luego **"Confirmar
   cambios"** (Commit changes) otra vez en la ventana que aparece (con
   **"Confirmar directamente en la rama main"** / "Commit directly to
   the main branch" seleccionado).

### Paso 9: Publicar la web con GitHub Pages

1. En tu repositorio de GitHub, pulsa la pestaña **"Configuración"** (Settings).
2. En el menú de la izquierda, pulsa **"Páginas"** (Pages).
3. En "Compilación e implementación" / "Build and deployment" → "Origen" /
   "Source", elige **"GitHub Actions"** (no "Implementar desde una rama" /
   "Deploy from a branch").
4. Ve a la pestaña **"Acciones"** (Actions) de tu repositorio. Verás un proceso en
   marcha (o ya terminado con una ✅ verde) llamado "Publicar en GitHub
   Pages". Espera a que termine (1-2 minutos).
5. Vuelve a **Configuración → Páginas** (Settings → Pages): arriba te dirá la dirección de tu web,
   algo como `https://tu-usuario.github.io/jaslem-jornada/`. Esa es la
   dirección que compartirás con tus trabajadores.

**Todavía no la abras** — antes hay que terminar la Parte 3, o la app no
sabrá a qué proyecto de Firebase conectarse. A partir de ahora, cada vez
que guardes un cambio en algún archivo de `public/` directamente en la
web de GitHub, esta publicación se repetirá sola automáticamente.

**Apunta esa dirección** (`https://tu-usuario.github.io/jaslem-jornada/`
o la que te haya salido a ti) — la necesitas en el siguiente paso.

### Paso 9-bis: Autorizar esa dirección en Firebase (imprescindible)

Sin este paso, los correos de invitación a los trabajadores y de "he
olvidado mi código" no funcionarán (Firebase los rechaza por seguridad si
vienen de una dirección web que no conoce).

1. En Firebase, ve a **Authentication → Settings** (⚙️ arriba, dentro de
   Authentication) → pestaña **"Authorized domains"** / "Dominios autorizados".
2. Pulsa **"Add domain"** / "Agregar dominio".
3. Escribe únicamente la parte del dominio, sin `https://` ni la barra
   final — por ejemplo, si tu dirección es
   `https://tu-usuario.github.io/jaslem-jornada/`, escribe solo:
   `tu-usuario.github.io`
4. Pulsa **"Add"** / "Agregar".

---

## PARTE 3 — Conectar la web con tu proyecto de Firebase

### Paso 10: Pegar tu configuración

Esto se hace editando el archivo directamente en la web de GitHub, sin
descargar ni subir nada:

1. En tu repositorio, entra en la carpeta `public` y pulsa sobre
   `index.html`.
2. Pulsa el icono del lápiz (✏️) arriba a la derecha del recuadro del
   código ("Editar este archivo" / "Edit this file").
3. Con el cursor dentro del código, pulsa Ctrl+F (Windows) o Cmd+F (Mac)
   — el buscador de tu navegador, no hace falta ninguno especial — y
   busca el texto `TU_API_KEY`.
4. Verás un bloque parecido a este:

   ```js
   const firebaseConfig = {
     apiKey: 'TU_API_KEY',
     authDomain: 'TU-PROYECTO.firebaseapp.com',
     projectId: 'TU-PROYECTO',
     storageBucket: 'TU-PROYECTO.appspot.com',
     messagingSenderId: 'TU_SENDER_ID',
     appId: 'TU_APP_ID'
   };
   ```

5. Selecciónalo y sustitúyelo entero por el bloque que copiaste en el
   **Paso 5.5** (el de tu propio proyecto de Firebase).
6. Baja hasta el final de la página y pulsa **"Confirmar cambios..."** (Commit changes...), y
   luego **"Confirmar cambios"** (Commit changes) otra vez (con "Confirmar
   directamente en la rama main" / "Commit directly to the main branch"
   seleccionado). Esto vuelve a publicar la web automáticamente
   (lo verás en la pestaña "Acciones" / "Actions"); espera 1-2 minutos.

### Paso 11: Subir las reglas de seguridad a Firestore

Las reglas de seguridad (el archivo `firestore.rules`, que ya tienes en
la carpeta descomprimida en tu ordenador) son las que impiden que
cualquiera pueda leer o modificar datos que no debería. Se pegan
directamente en la Consola de Firebase — no hace falta ninguna
herramienta adicional:

1. Abre el archivo `firestore.rules` de la carpeta del proyecto en tu
   ordenador con un editor de texto sencillo (Bloc de notas en Windows,
   TextEdit en Mac) y copia **todo** su contenido (Ctrl+A o Cmd+A, luego
   Ctrl+C o Cmd+C).
2. Ve a <https://console.firebase.google.com>, entra en tu proyecto y
   pulsa **"Firestore Database"** en el menú de la izquierda.
3. Arriba, pulsa la pestaña **"Reglas"** (o "Rules").
4. Verás un editor de texto con unas reglas por defecto. Haz clic dentro,
   selecciona todo (Ctrl+A / Cmd+A) y bórralo.
5. Pega (Ctrl+V / Cmd+V) el contenido que copiaste en el paso 1.
6. Pulsa el botón **"Publicar"** (o "Publish") arriba a la derecha del
   editor.

Si todo va bien, verás un aviso de que las reglas se han publicado
correctamente.

---

## PARTE 4 — Probarlo todo

1. Abre la dirección de tu web (la del **Paso 9.5**).
2. Ve a la pestaña **"Administración"**.
3. Inicia sesión con el email y la contraseña que creaste en el **Paso
   3.6**.
4. Deberías ver el mensaje de bienvenida y, debajo, la sección
   **"Gestión de trabajadores"** — da de alta a tu primer trabajador
   ahí, con su horario y su email (**es obligatorio poner su email
   correcto**, es a donde le llegará la invitación).
5. En esa misma lista, junto al trabajador recién creado, pulsa
   **"Enviar invitación"**.
6. Revisa el correo de ese trabajador (o el tuyo propio, si te has dado
   de alta a ti mismo como prueba): te llegará un enlace de JÁSLEM.
7. Abre ese enlace. La app te pedirá tu email, tu DNI/NIE y que elijas
   un **código de 6 dígitos** (dos veces, para confirmarlo). Ese código
   solo lo sabrás tú — ni siquiera el administrador puede verlo.
8. Ve a la pestaña **"Fichar"** y prueba a fichar con ese código de 6
   dígitos (ya no con el DNI/NIE).
9. Ve a **"Mis registros"**, escribe el email y el código, y comprueba
   que aparece el fichaje.

Si todo esto funciona, ¡ya está desplegado y en marcha!

---

## Uso del día a día

- **Dar de alta a un trabajador**: Administración → "Gestión de
  trabajadores" → rellena sus datos (con su email real), elige su
  **modalidad de trabajo** (100% presencial / 100% teletrabajo / mixta) →
  "Dar de alta". Todavía no puede fichar.
- **Editar sus datos más adelante**: el botón **"Editar datos"** de su
  tarjeta, en "Gestión de trabajadores", permite cambiar apellidos,
  nombre, categoría, NSS y email en cualquier momento. El **DNI/NIE no se
  puede cambiar ahí** (identifica su ficha en la base de datos): si se
  escribió mal, hay que dar de baja esa ficha y crear una nueva con el
  DNI correcto.
- **Horario partido (varias franjas al día)**: cada día de la semana
  admite **cualquier número de franjas horarias** — una (jornada
  continua), dos (mañana y tarde) o más — con el botón **"+ Añadir
  franja"** de cada día, y se pueden quitar con el botón **"✕"** de cada
  franja. No hace falta usar el mismo número de franjas todos los días.
- **Puntualidad**: cada entrada y cada salida se compara con la hora
  prevista de la franja más cercana ese día, con un margen de **10
  minutos, antes y después**. Fuera de ese margen, se pide
  obligatoriamente un motivo.
- **Modalidad de trabajo**: en "100% teletrabajo" el trabajador tiene
  libertad horaria — sus fichajes nunca se comparan con ningún horario, así
  que nunca salen avisos de retraso o salida anticipada. En "mixta" se
  marca, día a día, si ese día es presencial (sí se compara con el
  horario) o teletrabajo/mixto (libertad horaria ese día). La modalidad y
  el horario de un trabajador se pueden cambiar cuando haga falta con el
  botón **"Editar horario"** de su tarjeta, en "Gestión de trabajadores".
- **Invitarlo**: pulsa **"Enviar invitación"** junto a su nombre, cuando
  tú decidas (nunca se manda sola). Le llegará un correo para que elija
  su código de 6 dígitos.
- **Fichar**: los trabajadores usan la pestaña "Fichar" con su **código
  de 6 dígitos** (nunca con su DNI/NIE, que ya no sirve para fichar).
- **Mis registros**: el trabajador escribe su email y su código para
  ver su propio historial — hace falta haber aceptado antes la
  invitación.
- **¿Olvidó su código?**: desde "Mis registros" tiene un enlace "¿Has
  olvidado tu código?" que le manda un correo para elegir uno nuevo, sin
  que el administrador tenga que hacer nada.
- **Solicitar la corrección de un registro**: desde "Mis registros", el
  trabajador puede pulsar **"Solicitar corrección"** en **cualquier fila**
  (no solo en las marcadas en rojo) y elegir un motivo de la lista
  cerrada de causas justificadas. El trabajador solo indica el motivo —
  la hora correcta la decide siempre el administrador.
- **Resolver una corrección (administrador)**: en Administración →
  "Registros pendientes" aparecen tanto las incidencias automáticas
  (fichajes fuera de horario) como las solicitudes de corrección de los
  trabajadores. Al abrir una, el administrador elige el motivo (puede
  confirmar el del trabajador o poner el que considere correcto) y fija
  la **fecha y hora correctas**: ese valor pasa a ser el **oficial** del
  registro (el que cuenta para las horas trabajadas y los informes),
  aunque el fichaje original nunca se borra ni se sobrescribe — queda
  siempre visible, junto con el historial completo de correcciones. El
  administrador también puede corregir cualquier registro **por
  iniciativa propia**, sin que nadie se lo haya pedido, desde "Buscar
  registros de un trabajador concreto". Una corrección se puede volver a
  rectificar tantas veces como haga falta — no hay límite.
- **Administración**: el administrador entra con su email y contraseña
  de Firebase Authentication (creados en el Paso 3, o desde ahí mismo si
  quieres añadir más administradores).
- **Dar de baja**: al pulsar "Dar de baja", la app **descarga
  automáticamente y obligatoriamente** su historial completo (desde el
  primer día que fichó) en un PDF cifrado, antes de completar la baja.
  Guarda ese archivo y la contraseña que se muestra en ese momento — no
  se vuelve a mostrar. El trabajador dado de baja pierde su código de
  acceso al instante (ya no puede fichar ni entrar en "Mis registros"),
  pero todo su historial se conserva íntegro (obligación legal de un
  mínimo de 4 años) y sigue apareciendo, marcado como "De baja", en la
  lista de administración.
- **Ausencias**: al no haber un servidor funcionando todo el día, la
  comprobación de "¿quién no ha fichado hoy?" se ejecuta automáticamente
  cada vez que un administrador entra en Administración. Basta con que
  alguien abra la app una vez al día para que quede registrado.
- **Informes**: "Generar informes" permite elegir un periodo (o
  "Histórico completo") y descargar un PDF o Excel. Por defecto se
  entregan dentro de un ZIP cifrado con contraseña (ver más abajo).

### Cómo hacer cambios más adelante

Todo se sigue haciendo desde el navegador, sin instalar nada:

- **Cambios en algún archivo de `public/`** (por ejemplo, si algún día
  pides ayuda para ajustar algo del diseño): entra en el archivo dentro
  de la carpeta `public` en tu repositorio de GitHub, pulsa el lápiz
  (✏️) para editarlo, haz el cambio y pulsa **"Confirmar cambios..."** (Commit changes...). Si
  es un archivo nuevo que no existía (o cambia en varios archivos a la
  vez), usa **"Añadir archivo" (Add file) → "Subir archivos" (Upload files)** y arrastra los archivos
  nuevos a la carpeta correspondiente. En ambos casos, GitHub Pages
  republica la web sola en 1-2 minutos (lo ves en la pestaña
  "Acciones" / "Actions").
- **Cambios en `firestore.rules`** (las reglas de seguridad): pega de
  nuevo el contenido actualizado en la Consola de Firebase → Firestore
  Database → pestaña "Reglas" → "Publicar", igual que en el Paso 11.

---

## Cosas importantes que debes saber

### Cómo se protegen los informes (PDF/Excel)

Ni el PDF ni el Excel se pueden cifrar "por dentro" usando solo el
navegador (eso solo lo hacen programas de pago que corren en un
servidor, y este diseño no usa servidor a propósito). En su lugar, cada
informe se entrega dentro de un **ZIP cifrado con contraseña de verdad
(AES-256)** — el mismo cifrado fuerte que usan programas como WinZip o
7-Zip. Sin la contraseña, ese ZIP no se puede abrir en ningún programa.

Además, cada informe lleva impreso un **código de verificación** (una
huella digital única de sus datos) y queda un registro aparte,
inalterable, en Firestore (colección `descargas_certificadas`): quién lo
descargó, cuándo, y esa misma huella. Si alguien manipulase el documento
después de descargarlo, su código ya no coincidiría con el original —
así se puede demostrar más adelante que un documento concreto es
auténtico.

Al generar un informe protegido, la app te muestra la contraseña **una
sola vez**, en una ventana que hay que copiar a mano — no se guarda en
ningún sitio (ni en Firestore, ni en el navegador). Si la pierdes, hay
que volver a generar el informe.

### Nunca se elimina a un trabajador

Dar de baja (Administración → Gestión de trabajadores) nunca borra sus
datos ni su historial — solo le retira el acceso (su código de fichaje
deja de funcionar al instante). Es obligación legal conservar el
registro horario un mínimo de 4 años, y antes de completar la baja la
app te obliga a descargar su historial completo.

### Quién puede ver qué

- Para fichar o entrar en "Mis registros" hace falta el código de 6
  dígitos que **eligió el propio trabajador** — ni siquiera el
  administrador lo conoce ni puede recuperarlo (solo puede revocarlo,
  dando de baja). El único que puede leer los registros de otra persona
  es un administrador que haya iniciado sesión de verdad.
- El número de la Seguridad Social y el email de cada trabajador solo
  los puede ver un administrador que haya iniciado sesión de verdad.
- Nadie que no sea administrador puede ver la lista completa de
  trabajadores, ni corregir o resolver ningún registro, ni enviar
  invitaciones.

### Añadir más administradores más adelante

Repite el **Paso 3** (crear el usuario en Authentication) y el **Paso 4**
(crear su documento en `administradores` con ese UID) para cada persona
nueva que necesite acceso de administración.

---

## Si algo no funciona

- **"Missing or insufficient permissions"** en la pantalla: seguramente
  las reglas de seguridad no se subieron bien — repite el Paso 11.
- **La página se queda en blanco**: revisa que copiaste bien el bloque
  `firebaseConfig` completo en el Paso 10, sin dejarte ninguna coma ni
  comilla.
- **No puedo iniciar sesión como administrador**: comprueba que el email
  y la contraseña son exactamente los del Paso 3.6, y que creaste el
  documento en `administradores` con el UID correcto (Paso 4) — un solo
  carácter mal copiado hace que no funcione.
- **Los cambios no se ven en la web**: espera a que termine el proceso
  en la pestaña "Acciones" / "Actions" de GitHub (tarda 1-2 minutos), y luego recarga
  la página forzando que no use la copia guardada (Ctrl+F5 en Windows,
  Cmd+Shift+R en Mac).

Para cualquier otra cosa, vuelve a esta conversación y cuéntame
exactamente qué mensaje de error ves — con eso puedo ayudarte a
solucionarlo.
