# TileNet model

`best_model.pt` is copied from AutoMajsoul revision `1ea1f06`.

- SHA-256: `839fe5848cfeae661e5a95860e176739883215f9d13922963b8e21fc8770048c`
- Classes: 34 standard Japanese Mahjong tiles, 3 red fives, and one `x`
  class used to reject non-tile/background crops
- Input: RGB, 64x64, normalized with mean `0.5` and standard deviation `0.5`
- License: CC BY-NC-SA 4.0; see `../third_party/AutoMajsoul-LICENSE.txt`

The recognition pipeline supplements this legacy model with normalized tile
faces and pin-circle structure validation. `backend/training/train_spatial.py`
can produce a `spatial_tilenet_v2` checkpoint after a sufficiently varied,
labeled real-screenshot dataset has been collected and validated.
