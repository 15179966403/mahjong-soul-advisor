# 本地截图识别核心

该目录是 Mahjong Soul Advisor 的本地识别后端。它提供“本地截图 → JSON”命令行流程和仅监听本机的 HTTP API，不包含网页上传界面或 Android 自动化。

## 环境

```bash
cd /Users/mac/code/mahjong-soul-advisor
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
```

依赖版本已针对项目当前的 Python 3.9 环境锁定。PyTorch 2.2.2 使用
NumPy 1.x ABI，因此不要将 NumPy 单独升级到 2.x；OpenCV 同样固定在
仍兼容 NumPy 1.26 的版本。

如果此前已经按照旧版依赖安装了 NumPy 2.x 和 OpenCV 4.14，请先修复环境：

```bash
python -m pip install --force-reinstall \
  "numpy==1.26.4" \
  "opencv-python-headless==4.10.0.84"
python -m pip install -r backend/requirements.txt
```

## 命令行识别

```bash
python -m backend.recognize /absolute/path/to/screenshot.png
```

将 JSON 保存到文件：

```bash
python -m backend.recognize /absolute/path/to/screenshot.png \
  --output backend/output/result.json
```

保存牌桌定位、区域切割和单张牌切片：

```bash
python -m backend.recognize /absolute/path/to/screenshot.png \
  --debug-dir backend/debug
```

`backend/output/`、`backend/debug/`、`backend/uploads/` 和 `datasets/private/` 均由 `.gitignore` 排除。请勿将私人对局截图提交到仓库。

## 本地识别 API

启动服务：

```bash
python -m backend.serve
```

服务默认只监听 `127.0.0.1:8765`。健康检查：

```bash
curl http://127.0.0.1:8765/api/health
```

识别截图时，将原始图片二进制放入请求体，并提供正确的图片类型：

```bash
curl --request POST \
  --header "Content-Type: image/jpeg" \
  --data-binary @/absolute/path/to/screenshot.jpeg \
  http://127.0.0.1:8765/api/recognize
```

支持 PNG、JPEG 和 WebP。默认限制为 12 MB、单边不超过 8192 像素、总像素不超过 2400 万，识别超时为45秒。API 不保存上传内容或调试图片，请求完成后只返回结构化 JSON。

浏览器访问默认允许来自 `localhost` 或 `127.0.0.1` 的 4173、5173 端口。配置项示例见根目录 `.env.example`；该文件只用于说明，需要在启动进程前通过 shell 导出配置。例如：

```bash
export MAHJONG_API_PORT=8765
export MAHJONG_RECOGNITION_TIMEOUT_SECONDS=60
python -m backend.serve
```

错误响应统一为：

```json
{
  "error": {
    "code": "TABLE_NOT_FOUND",
    "message": "未能在截图中定位雀魂牌桌",
    "requestId": "..."
  }
}
```

`X-Request-ID` 同时写入响应头，便于将前端错误与本地日志对应。服务禁止绑定非回环地址，避免截图识别接口意外暴露到局域网。

## 筒子结构校验

当前 checkpoint 对部分高位筒子存在分类偏置。识别流程会先移除牌面顶部的绿色牌背，再由 TileNet 判断花色和类别；当模型判断为筒子时，会额外使用多阈值圆形检测校验筒子数量。

如果结构结果修正了模型分类，JSON 会保留原始判断：

```json
{
  "code": "7p",
  "confidence": 0.92,
  "recognition": {
    "source": "pin-circle-count",
    "modelCode": "4p",
    "modelConfidence": 0.34,
    "circleCount": 7,
    "structureConfidence": 0.92,
    "structureVotes": [7, 7, 7]
  }
}
```

结构判断是现有模型的辅助修复。长期方案是使用真实截图数据训练保留 `4×4` 空间布局的 TileNet v2。

## 收集真实牌面

未标注收集：

```bash
python -m backend.collect_tiles /absolute/path/to/screenshot.jpeg
```

已知从左到右标签时直接标注：

```bash
python -m backend.collect_tiles /absolute/path/to/screenshot.jpeg \
  --labels 1m,3m,7m,3p,4p,6p,7p,7p,1z,1z,2z,6z,7z,8p
```

切片默认保存在被 Git 忽略的 `datasets/private/tiles/`。

## 训练空间模型

训练代码使用 `4×4` 空间特征网格、保持宽高比的牌面输入、按类别分层划分和逐类别混淆统计。它可以复用旧模型的卷积层，但必须使用真实标注数据生成新的 checkpoint。

```bash
python -m pip install -r backend/requirements-training.txt

python -m backend.training.train_spatial \
  --data-dir datasets/private/tiles \
  --output-dir backend/models/v2
```

训练并验证完成前，正式识别仍使用 `backend/models/best_model.pt`。不要用未经验证的新权重覆盖现有模型。

模型来自 AutoMajsoul，来源和许可见根目录 `THIRD_PARTY_NOTICES.md` 以及 `backend/third_party/AutoMajsoul-LICENSE.txt`。
