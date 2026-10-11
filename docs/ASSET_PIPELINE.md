# Asset pipeline

## Art direction

ASTrix uses a warm woodland field-journal palette: leaf greens, muted ochre earth, fired-clay roof/cloth accents, and parchment UI. Silhouettes and resource states remain high contrast from the isometric camera. The clearing, footpath, ground relief and meadow instances are procedural presentation geometry; the worker, cabin, berry bush, basket, logs and stockpile remain original project geometry. Tree/stump GLBs introduce a consistent crafted low-poly shape language without making simulation state live in the mesh.

## External assets

| Asset | Source / author | License / attribution | Local path | Modifications |
| --- | --- | --- | --- | --- |
| `tree_default` | [Kenney Nature Kit](https://kenney.nl/assets/nature-kit), Kenney; redistributed [OpenGameArt item](https://opengameart.org/content/nature-kit), Kenney | CC0 1.0; attribution to Kenney is optional but included here | `public/assets/kenney-broadleaf.glb` | GLB loaded by Three.js; normalized to 2.2 world units, colors tuned to ASTrix leaf/bark palette, roughness raised, cloned materials, casts/receives entity shadows. |
| `tree_oak` | Same kit and author | CC0 1.0; optional attribution | `public/assets/kenney-oak.glb` | Same normalization and material adjustments. |
| `tree_pineTallA` | Same kit and author | CC0 1.0; optional attribution | `public/assets/kenney-pine.glb` | Same normalization and material adjustments. |
| `stump_roundDetailed` | Same kit and author | CC0 1.0; optional attribution | `public/assets/kenney-stump.glb` | Normalized to 0.5 world units and shown when the corresponding simulation tree is depleted. |

The source archive is **Nature Kit (2.1)**, published by Kenney on OpenGameArt on 2018-04-12, 10.5 MB. Its included license is preserved at `public/assets/KENNEY-NATURE-KIT-LICENSE.txt`; it states CC0 and that credit is appreciated but not required. The full 329-model archive is not shipped. Only the four GLBs required for this world were extracted; there are no external textures. The original download is from `https://opengameart.org/sites/default/files/Nature%20Kit%20%282.1%29.zip`.

## Loading and state ownership

`GlbNatureAssetCatalog` asynchronously loads the compact GLBs through Three.js `GLTFLoader` and caches the parsed source geometry. Until a tree model resolves (or if it fails to load), the original procedural silhouette remains visible. Once resolved, the model replaces its fallback; when the simulation reports a depleted tree, the model is hidden and a stump appears. Tree health, resource creation, agent activity, and event order remain solely in `WorldState`/`WorldSimulation`; animation cannot determine a successful chop. Berry, basket, log, worker and cabin state-sensitive presentation remains procedural.

Ground cover shares one cone geometry and uses `InstancedMesh`; forest-edge GLBs use the same small source set with material/geometry cloning but no shadows. Textures are absent from external GLBs, avoiding added texture memory. The four delivered binary models total about 40 KB. The current world uses a 70-unit tessellated terrain plane, under 320 ground-cover instances, 50 forest-edge positions, one 1024-square directional shadow map, and a capped 1.75 device pixel ratio.

## Remaining asset work

The Kenney kit improves the main tree and stump silhouettes substantially, but ASTrix still needs a bespoke/curated worker and cabin model with the same authored quality; those remain custom procedural geometry today. Use additional GLBs only when they clearly outperform current project geometry and preserve the established palette and low-poly style. Keep bundle cost and draw/shadow counts measured on mobile/tablet hardware.
