# Third-party notices

## Riichi Mahjong Tiles

The Mahjong tile artwork in `public/assets/tiles/` is derived from:

- Project: `FluffyStuff/riichi-mahjong-tiles`
- Source: <https://github.com/FluffyStuff/riichi-mahjong-tiles>
- Source revision: `26e127ba2117f45cdce5ea0225748cc0cfad3169`
- Author's license statement: "All assets are in the public domain."
- Public-domain dedication: <https://creativecommons.org/publicdomain/zero/1.0/>

The source `Export/Regular/Front.png` was composited with the corresponding
`Export/Regular/*.png` tile face. The resulting files were renamed to the
standard `1m`–`9m`, `1p`–`9p`, `1s`–`9s`, and `1z`–`7z` notation and resized
for web delivery. No generative-AI artwork is used in these tile assets.

## AutoMajsoul recognition pipeline

The offline screenshot-recognition backend in `backend/recognition/` and the
bundled TileNet checkpoint in `backend/models/best_model.pt` are adapted from:

- Project: `15179966403/AutoMajsoul` (fork of AutoMajsoul)
- Source: <https://github.com/15179966403/AutoMajsoul>
- Source revision: `1ea1f06`
- License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0
  International (CC BY-NC-SA 4.0)
- Bundled license text: `backend/third_party/AutoMajsoul-LICENSE.txt`
- Model SHA-256: `839fe5848cfeae661e5a95860e176739883215f9d13922963b8e21fc8770048c`

The adapted implementation retains only table detection, perspective
normalization, hand/river tile segmentation, the TileNet architecture, and
the trained checkpoint. Android device control, login automation, button
clicking, game strategy, and automatic play are not included. The adapted
code separates geometry from classification, returns confidence values and
original-image bounding boxes, normalizes red-five labels, and exposes an
offline JSON command-line interface.
