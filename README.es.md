<p align="center">
  <img alt="logotipo de kodus" src="https://kodus.io/wp-content/uploads/2026/06/kodus-thumb-git-scaled.png">
</p>

<p align="center">
   <a href="http://makeapullrequest.com">
      <img alt="PRs bienvenidos" src="https://img.shields.io/badge/PRs-welcome-darkgreen.svg?style=shields" />
   </a>
   <a href="https://github.com/kodustech/kodus-ai" target="_blank">
      <img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Estrellas de Github" />
   </a>
   <a href="./license.md">
      <img src="https://img.shields.io/badge/license-AGPLv3-red" alt="Licencia" />
   </a>
</p>

---

<p align="center">
   <a href="https://kodus.io">Sitio web</a> ·
   <a href="https://discord.gg/6WbWrRbsH7">Comunidad</a> ·
   <a href="https://docs.kodus.io">Docs</a> ·
   <a href="https://docs.kodus.io/how_to_use/en/cli/overview">Docs del CLI</a> ·
   <strong><a href="https://app.kodus.io">Prueba Kodus Cloud </a></strong> ·
   <strong><a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">Guía de Self-Host</a></strong>
</p>

<p align="center">
   🌐
   <a href="./README.md">English</a> ·
   <a href="./README.pt-BR.md">Português (BR)</a> ·
   <a href="./README.es.md">Español</a> ·
   <a href="./README.ja.md">日本語</a> ·
   <a href="./README.zh-CN.md">简体中文</a> ·
   <a href="./README.fr.md">Français</a>
</p>

## Por qué los equipos eligen Kodus

- **Agnóstico de modelos**: Usa Claude, GPT-5, Gemini, Llama, GLM, Kimi o cualquier endpoint compatible con OpenAI.
- **Sin recargo en los costos de LLM**: Pagas directamente a los proveedores de modelos. Sin multiplicadores ocultos.
- **Aprende de tu contexto**: Kody se adapta a tu arquitectura, estándares y flujo de trabajo.
- **Tú estableces las reglas**: Define reglas de revisión personalizadas en lenguaje natural.
- **Privacidad y seguridad**: El código fuente no se usa para entrenar modelos, los datos se cifran en tránsito y en reposo, y se admiten runners self-hosted. Las instancias self-hosted envían un heartbeat anónimo por día (solo contadores agregados — sin código, nombres ni identificadores); desactívalo con `KODUS_TELEMETRY_DISABLED=true`. Consulta [Telemetría anónima](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/telemetry).
- **Flujo de Git nativo**: Funciona directamente en PRs con GitHub, GitLab, Bitbucket y Azure Repos.
- **Listo para CLI + CI/CD**: Ejecuta revisiones localmente y en pipelines.
- **Impacto operativo**: Haz seguimiento de la deuda técnica y métricas de entrega manteniendo alta la calidad de revisión.

## Características destacadas del producto

<details>
  <summary><strong>🔑 Trae Tu Propia Clave (BYOK)</strong></summary>
<br />
Conecta tus propias credenciales de proveedor y elige los modelos detrás de las revisiones de Kodus: OpenAI, Anthropic, Google Gemini, Vertex AI, Novita o cualquier endpoint compatible con OpenAI. Mantén la facturación y el uso bajo tu propia cuenta de proveedor, sin recargos ocultos de LLM.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/byok-scaled.png" alt="Configuración de proveedor de modelos Kodus BYOK" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>📈 Uso de Tokens</strong></summary>
<br />
Haz seguimiento del consumo de tokens en las revisiones de código con IA, comprende los factores de costo y mantén el gasto de modelos predecible a medida que crece la adopción.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/token-usage-scaled.png" alt="Dashboard de uso de tokens de Kodus" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>⚙️ Kody Rules</strong></summary>
<br />
Kody Rules permite a los equipos definir instrucciones de revisión en lenguaje natural y aplicarlas en organizaciones, repositorios, rutas o ámbitos de revisión específicos. Kody usa esas reglas como contexto al revisar pull requests, ayudando a aplicar decisiones de arquitectura, expectativas de seguridad, prácticas de testing y convenciones específicas del repositorio sin depender de que los revisores repitan manualmente los mismos comentarios.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/rules-scaled.png" alt="Reglas de Kody" width="900">
</p>
</details>
<br />
<details>
  <summary><strong>📊 Cockpit</strong></summary>
<br />
Cockpit ayuda a los equipos a medir la efectividad de las revisiones de Kodus, la salud de las Kody Rules, la salud de los repositorios y las métricas de entrega en todo el flujo de trabajo de ingeniería.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/cockpit-kodus-scaled.png" alt="Cockpit de Kodus mostrando la salud del pipeline de revisión de código con IA" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>🧩 Kody Issues</strong></summary>
<br />
Haz seguimiento automático de las sugerencias no implementadas de pull requests cerrados, gestiónalas por estado, severidad, categoría y repositorio, y deja que Kody las resuelva cuando la corrección aparezca en un PR futuro.
<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/issues-scaled.png" alt="Dashboard de Kody Issues" width="900">
</p>

</details>

<br />
<details>
  <summary><strong>🔎 Mira a Kody revisando un pull request real</strong></summary>
<br />
Kody hace más que resumir diffs. Revisa código con contexto, marca riesgos por severidad y sugiere correcciones concretas directamente en el pull request.

<br />
<br />

<p align="center">
  <img
    src="https://kodus.io/wp-content/uploads/2025/12/review-kody-.png"
    alt="Kody detectando un problema crítico de seguridad IDOR en una revisión de pull request"
    width="700"
  />
</p>

En este ejemplo, Kody detecta un riesgo crítico de IDOR donde un parámetro de consulta `organizationId` podría evadir la protección de tenant al pasarse como un array, y luego sugiere una validación explícita en tiempo de ejecución antes de que el código se fusione.

</details>

## Comienza

Elige el flujo de trabajo que coincida con cómo quieres usar Kodus.

<table>
  <tr>
    <td width="50%">
      <strong>Prueba Kodus Cloud</strong>
      <br />
      Comienza a revisar pull requests sin gestionar infraestructura.
      <br />
      <br />
      <a href="https://app.kodus.io/signup">Crea una cuenta gratuita</a>
      ·
      <a href="https://kodus.io/pricing">Ver precios</a>
    </td>
    <td width="50%">
      <strong>Self-host Kodus</strong>
      <br />
      Despliega Kodus en tu propia infraestructura con control sobre los datos,
      los modelos y la configuración de ejecución.
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">Guía de instalación</a>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Usa el CLI</strong>
      <br />
      Ejecuta revisiones de código con IA desde tu terminal sobre un árbol de
      trabajo, diff staged, rama o commit.
      <br />
      <br />
      <code>kodus review</code>
      <br />
      <code>kodus review --staged</code>
      <br />
      <code>kodus review --prompt-only</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_use/en/cli/introduction">Visión general del CLI</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/commands">Referencia de comandos</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/ci_cd">CI/CD</a>
    </td>
    <td width="50%">
      <strong>Contribuye localmente</strong>
      <br />
      Ejecuta el monorepo de Kodus localmente para desarrollo en la API, worker,
      servicio de webhooks, aplicación web e infraestructura local.
      <br />
      <br />
      <code>git clone https://github.com/kodustech/kodus-ai.git</code>
      <br />
      <code>cd kodus-ai</code>
      <br />
      <code>yarn setup</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator">Quickstart local</a>
    </td>
  </tr>
</table>

## Estructura del Monorepo

Kodus es un monorepo con múltiples aplicaciones, librerías de dominio compartidas y paquetes publicados.

```txt
kodus-ai/
├── apps/
│   ├── api/          # API NestJS
│   ├── web/          # Dashboard Next.js
│   ├── worker/       # Ejecución de revisiones y consumidores de cola
│   └── webhooks/     # Ingestión de webhooks de proveedores Git
├── libs/             # Módulos de dominio NestJS compartidos
├── packages/
│   ├── kodus-flow/   # SDK de orquestación de agentes IA
│   └── kodus-common/ # Paquete de abstracción de LLM
└── scripts/          # Scripts de dev, deploy, benchmark y automatización
```

| Ruta | Propósito |
| --- | --- |
| `apps/api` | API NestJS principal para autenticación, organizaciones, equipos, Kody Rules, integraciones, permisos y orquestación de revisiones de código. |
| `apps/web` | Aplicación web Next.js para el dashboard de Kodus. |
| `apps/worker` | Servicio en segundo plano para la ejecución de revisiones de código, procesamiento de colas, verificación de sugerencias, jobs de automatización y tareas de monitoreo. |
| `apps/webhooks` | Servicio de ingestión de webhooks para eventos de GitHub, GitLab, Azure Repos, Bitbucket y Forgejo. |
| `libs` | Módulos de dominio NestJS compartidos usados en todas las aplicaciones de Kodus. |
| `packages/kodus-flow` | SDK para orquestación de agentes IA. |
| `packages/kodus-common` | Paquete de abstracción de LLM compartido para proveedores de modelos. |

Para instrucciones completas de configuración, sigue el [Quickstart local](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator).

## Open Source vs. Teams vs. Enterprise

| Característica | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-community2-scaled.webp" alt="Kody Community" width="110" /><br>Community | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-team-scaled.webp" alt="Kody Teams" width="110" /><br>Teams | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-enterprise-scaled.webp" alt="Kody Enterprise" width="110" /><br>Enterprise |
| :--- | :---: | :---: | :---: |
| Precio | Gratis | $10/dev mensual o $8/dev anual (+ tokens/dev) | Personalizado |
| Hosting | Self-hosted **o** alojado por Kodus | Alojado por Kodus | Self-hosted **o** alojado por Kodus |
| Trae Tu Propia Clave (BYOK) | ✅ | ✅ | ✅ |
| Uso de PR | PRs ilimitados usando tu propia API key | PRs ilimitados usando tu propia API key | PRs ilimitados usando la API key de Kodus AI Tokens |
| Usuarios | Ilimitados | Ilimitados | Ilimitados |
| Kody Rules | Hasta 10 | Ilimitadas | Ilimitadas |
| Plugins activos | Hasta 3 | Ilimitados | Ilimitados |
| Kody Learnings y Memory | ✅ | ✅ | ✅ |
| Issues del Quality Radar | Ilimitados | Ilimitados | Ilimitados |
| Cola prioritaria para Kody Agents | ❌ | ✅ | ✅ |
| Métricas de ingeniería / Cockpit | ❌ | ✅ | ✅ |
| SSO | ❌ | ❌ | ✅ |
| RBAC + logs de auditoría + analítica | ❌ | ❌ | ✅ |
| Cumplimiento | ❌ | ❌ | SOC 2 |
| Soporte | Soporte de la comunidad en Discord | Comunidad en Discord + Soporte por Email | Discord privado + Email + hasta 5h/mes de onboarding/soporte dedicado |

[Compara todos los planes →](https://kodus.io/pricing)

## Recursos

| Recurso | Descripción |
| --- | --- |
| [Sitio web](https://kodus.io) | Conoce más sobre Kodus, las capacidades del producto y los precios. |
| [Documentación](https://docs.kodus.io) | Guías de configuración, docs del producto, uso del CLI e instrucciones de self-hosting. |
| [Kodus Cloud](https://app.kodus.io) | Comienza a usar Kodus sin gestionar infraestructura. |
| [Guía de Self-Host](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm) | Despliega Kodus en tu propio entorno. |
| [Docs del CLI](https://docs.kodus.io/how_to_use/en/cli/overview) | Ejecuta revisiones de código con IA localmente, en CI/CD o dentro de agentes de codificación. |
| [Comunidad de Discord](https://discord.gg/6WbWrRbsH7) | Haz preguntas, obtén ayuda de configuración y habla con el equipo de Kodus. |
| [Precios](https://kodus.io/pricing) | Compara las ediciones Community, Teams y Enterprise. |
| [Agenda una llamada](https://cal.com/gabrielmalinosqui/30min) | Habla con el equipo de Kodus sobre configuración, self-hosting o necesidades enterprise. |



## Contribuir

<p align="left">
  <img src="https://kodus.io/wp-content/uploads/2026/06/kody-contributing-scaled.png" alt="Kody contribuyendo" width="230" />
</p>

Agradecemos contribuciones de todos los tamaños 🧡

Corrige un typo, mejora los docs, reporta un bug, sugiere una feature o abre un pull request para algo que crees que debería existir.

¿No sabes por dónde empezar? Abre un issue o únete a la comunidad. Estamos felices de ayudar.
