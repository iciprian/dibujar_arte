# Dibujar Arte

Describe a character → pick a concept image → get a 3D model → download it as a `.glb` at the exact size you want in cm.

A small personal alternative to meshy.ai. It runs on your Mac and uses [fal.ai](https://fal.ai) for the AI work.

## Setup (once)

1. Create a fal.ai key at <https://fal.ai/dashboard/keys> and add some credit at <https://fal.ai/dashboard/billing>.
2. In this folder:
   ```sh
   cp .env.example .env      # then paste your key after FAL_KEY=
   npm install
   ```

## Use

```sh
npm start
```

Open <http://127.0.0.1:3737>.

1. **Describe** your character, e.g. *"a small friendly forest gnome with a red mushroom hat, cartoon style"*. Press **Draw concepts** (⌘+Enter also works).
2. **Pick** the concept you like and press **Make 3D**. It runs in the background (usually 1–3 min). You can close the tab, and if you restart the app it picks the job up again.
3. **Export**: type the size in cm and choose which side it measures (height, width, depth or longest side). Then press **Download .glb**.

The exported model is scaled exactly (glTF uses metres, so 15 cm = 0.15). It is centred, its feet are at 0, and the scale is baked into the mesh, so Blender, Unity and AR viewers all show the real size.

Everything you make is saved in `library/<id>/` (`model.glb`, `concept.png`, `meta.json`).

## Costs (fal.ai, Nov 2026)

| Step | Model | Price |
|---|---|---|
| Concept image | Nano Banana 2 | ~$0.08 each |
| | FLUX.1 dev | ~$0.02 each |
| | FLUX.1 schnell | <$0.01 each |
| 3D model | Hunyuan 3D v3.1 Rapid | $0.225 (+$0.15 PBR) |
| | Hunyuan 3D v3.1 Pro | $0.375 (+$0.15 PBR) |
| | TRELLIS 2 | $0.30 |

To add or change models, edit `src/engines.js`.

## Tips

- Keep the description about **one character**. The app automatically adds "full body, front view, plain white background", which is what the 3D models need.
- If a model looks wrong, it is usually the concept image. Draw new concepts rather than re-running the 3D step.
- `npm test` checks the cm resizing.
