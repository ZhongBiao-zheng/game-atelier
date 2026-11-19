// Atelier PS 联动（ps-bridge）在 Photoshop 里执行的脚本。ES3 / ExtendScript。
// viewer-server 经 osascript「do javascript」传入加载器文本 $.evalFile(本文件)，唯一参数是请求目录里
// config.json 的路径。配置由服务端 json.dumps(ensure_ascii=True) 写出，只含 ASCII，按 JSON 读。
// 结果写到 config.result；PS 侧的任何异常都写进回执，不弹框。
var ATELIER_ARGS = (typeof arguments !== 'undefined' && arguments) ? arguments : [];

(function (args) {
    function now() { return new Date().getTime(); }

    function quote(text) {
        var out = '"', i, code, ch, hex;
        for (i = 0; i < text.length; i++) {
            ch = text.charAt(i);
            code = text.charCodeAt(i);
            if (ch === '"' || ch === '\\') out += '\\' + ch;
            else if (code < 32 || code > 126) {
                hex = code.toString(16);
                while (hex.length < 4) hex = '0' + hex;
                out += '\\u' + hex;
            } else out += ch;
        }
        return out + '"';
    }

    function toJson(value) {
        var parts = [], key, i;
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'string') return quote(value);
        if (typeof value === 'number') return isFinite(value) ? String(value) : 'null';
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (value instanceof Array) {
            for (i = 0; i < value.length; i++) parts.push(toJson(value[i]));
            return '[' + parts.join(',') + ']';
        }
        for (key in value) {
            if (value.hasOwnProperty(key)) parts.push(quote(key) + ':' + toJson(value[key]));
        }
        return '{' + parts.join(',') + '}';
    }

    function readText(path) {
        var file = new File(path);
        file.encoding = 'UTF-8';
        if (!file.open('r')) throw new Error('CONFIG_UNREADABLE');
        try { return file.read(); } finally { file.close(); }
    }

    function writeText(path, text) {
        var file = new File(path);
        file.encoding = 'UTF-8';
        if (!file.open('w')) throw new Error('RESULT_UNWRITABLE');
        try { file.write(text); } finally { file.close(); }
    }

    function px(value) { return value.as('px'); }

    function boundsPx(bounds) { return [px(bounds[0]), px(bounds[1]), px(bounds[2]), px(bounds[3])]; }

    function documentPath(doc) {
        try { return doc.fullName.fsName; } catch (e) { return null; }
    }

    function describe(doc) {
        return { id: doc.id, name: doc.name, path: documentPath(doc), width: px(doc.width), height: px(doc.height) };
    }

    function selectionBounds(doc) {
        try { return boundsPx(doc.selection.bounds); } catch (e) { return null; }
    }

    function hasLayer(container, layerId) {
        var i, child;
        for (i = 0; i < container.layers.length; i++) {
            child = container.layers[i];
            if (child.id === layerId) return true;
            if (child.typename === 'LayerSet' && hasLayer(child, layerId)) return true;
        }
        return false;
    }

    // 只留下这一个图层（以及包着它的组），其余全部隐藏。
    function isolate(container, layerId) {
        var i, child;
        for (i = 0; i < container.layers.length; i++) {
            child = container.layers[i];
            if (child.id === layerId) child.visible = true;
            else if (child.typename === 'LayerSet' && hasLayer(child, layerId)) {
                child.visible = true;
                isolate(child, layerId);
            } else child.visible = false;
        }
    }

    function mergeToOneLayer(doc) {
        var i;
        for (i = doc.layers.length - 1; i >= 0; i--) {
            if (!doc.layers[i].visible) doc.layers[i].remove();
        }
        if (doc.layers.length > 1 || doc.layers[0].typename === 'LayerSet') doc.mergeVisibleLayers();
        if (doc.activeLayer.isBackgroundLayer) doc.activeLayer.isBackgroundLayer = false;
    }

    // 选区存进临时通道 → 复制文档 → 原文档撤回到操作前；在副本里合并、按通道清掉选区外、裁到外接框。
    // 不碰系统剪贴板（第 0 批探针：合并拷贝法会覆盖剪贴板）。
    function exportImage(cfg, result) {
        if (!app.documents.length) throw new Error('NO_DOCUMENT');
        var doc = app.activeDocument;
        var bounds = selectionBounds(doc);
        var layer = doc.activeLayer;
        result.document = describe(doc);
        result.selection = bounds;
        result.scope = cfg.scope;
        result.layer = cfg.scope === 'layer' ? layer.name : null;
        var layerId = layer.id;
        var before = doc.activeHistoryState;
        if (bounds) {
            var channel = doc.channels.add();
            channel.name = 'atelier-selection';
            doc.selection.store(channel, SelectionType.REPLACE);
        }
        var copy = doc.duplicate('atelier-export', false);
        app.activeDocument = doc;
        doc.activeHistoryState = before;
        try {
            app.activeDocument = copy;
            if (cfg.scope === 'layer') isolate(copy, layerId);
            mergeToOneLayer(copy);
            if (bounds) {
                var saved = copy.channels.getByName('atelier-selection');
                copy.selection.load(saved, SelectionType.REPLACE);
                copy.selection.invert();
                copy.selection.clear();
                copy.selection.deselect();
                saved.remove();
                copy.crop([UnitValue(bounds[0], 'px'), UnitValue(bounds[1], 'px'),
                    UnitValue(bounds[2], 'px'), UnitValue(bounds[3], 'px')]);
            }
            if (copy.mode !== DocumentMode.RGB) copy.changeMode(ChangeMode.RGB);
            if (copy.bitsPerChannel !== BitsPerChannelType.EIGHT) copy.bitsPerChannel = BitsPerChannelType.EIGHT;
            var options = new PNGSaveOptions();
            options.compression = 6;  // PS 默认不压缩：2200² 的 PNG 是 19 MB
            copy.saveAs(new File(cfg.out_png), options, true, Extension.LOWERCASE);
        } finally {
            copy.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = doc;
        }
    }

    function findTarget(target, active) {
        var docs = app.documents, i;
        if (!target) return active;
        // 文档 id 只在本次 PS 会话里唯一：PS 重启后同一个 id 可能是别的文档，所以 id 要与名字同时对上。
        for (i = 0; i < docs.length; i++) {
            if (target.doc_id && docs[i].id === target.doc_id && docs[i].name === target.name) return docs[i];
        }
        for (i = 0; i < docs.length; i++) if (target.path && documentPath(docs[i]) === target.path) return docs[i];
        for (i = 0; i < docs.length; i++) if (target.name && docs[i].name === target.name) return docs[i];
        if (target.strict) throw new Error('TARGET_NOT_OPEN');
        return active;
    }

    // 置入为智能对象。layer.bounds 只算不透明像素（探针第 5 项），用服务端给的不透明范围换算倍数与画布原点。
    function placeImage(cfg, result) {
        var active = app.documents.length ? app.activeDocument : null;
        if (cfg.target) result.target_name = cfg.target.name;
        var doc = findTarget(cfg.target, active);
        if (!doc) {
            doc = app.documents.add(UnitValue(cfg.png_width, 'px'), UnitValue(cfg.png_height, 'px'), 72,
                cfg.layer_name, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            result.created_document = true;
        }
        app.activeDocument = doc;
        var pw = cfg.png_width, ph = cfg.png_height, b = cfg.bounds, scale = 1, left, top;
        if (b) {
            scale = Math.min((b[2] - b[0]) / pw, (b[3] - b[1]) / ph);
            left = b[0] + ((b[2] - b[0]) - pw * scale) / 2;
            top = b[1] + ((b[3] - b[1]) - ph * scale) / 2;
        } else {
            left = (px(doc.width) - pw) / 2;
            top = (px(doc.height) - ph) / 2;
        }
        var desc = new ActionDescriptor();
        desc.putPath(charIDToTypeID('null'), new File(cfg.png));
        desc.putEnumerated(charIDToTypeID('FTcs'), charIDToTypeID('QCSt'), charIDToTypeID('Qcsa'));
        executeAction(charIDToTypeID('Plc '), desc, DialogModes.NO);
        var layer = doc.activeLayer;
        var c = cfg.png_content_bounds;
        var placed = boundsPx(layer.bounds);
        var actual = (placed[2] - placed[0]) / (c[2] - c[0]);
        if (Math.abs(actual - scale) > 1e-6) layer.resize(scale / actual * 100, scale / actual * 100, AnchorPosition.TOPLEFT);
        var moved = boundsPx(layer.bounds);
        layer.translate(UnitValue(left + c[0] * scale - moved[0], 'px'), UnitValue(top + c[1] * scale - moved[1], 'px'));
        layer.name = cfg.layer_name;
        result.target = describe(doc);
        result.placed_bounds = boundsPx(layer.bounds);
    }

    function layerTree(container, depth, budget) {
        var items = [], i, layer, item;
        for (i = 0; i < container.layers.length && budget.left > 0; i++) {
            layer = container.layers[i];
            budget.left--;
            item = { id: layer.id, name: layer.name, type: layer.typename, visible: layer.visible, opacity: layer.opacity };
            if (layer.typename === 'LayerSet') {
                if (depth < 10) item.layers = layerTree(layer, depth + 1, budget);
            } else item.kind = String(layer.kind);
            items.push(item);
        }
        return items;
    }

    // 给 Agent 看的文档状态：文档列表、活动文档、活动文档的图层（最多 300 个）。
    function inspect(result) {
        var docs = [], i, budget = { left: 300 };
        for (i = 0; i < app.documents.length; i++) docs.push(describe(app.documents[i]));
        result.version = app.version;
        result.documents = docs;
        result.active_document = app.documents.length ? app.activeDocument.name : null;
        result.active_document_id = app.documents.length ? app.activeDocument.id : null;
        if (app.documents.length) {
            result.layers = layerTree(app.activeDocument, 0, budget);
            result.layers_truncated = budget.left <= 0;
        }
    }

    function documentById(id) {
        for (var i = 0; i < app.documents.length; i++) if (app.documents[i].id === id) return app.documents[i];
        throw new Error('DOCUMENT_NOT_FOUND');
    }

    // 预览：复制活动文档（或指定文档）、合并、转 RGB 8 位、长边缩到 1600，存 PNG；原文档不动。
    function previewDocument(cfg, result) {
        if (!app.documents.length) throw new Error('NO_DOCUMENT');
        var doc = cfg.document_id ? documentById(cfg.document_id) : app.activeDocument;
        var active = app.activeDocument;
        var copy = doc.duplicate('atelier-preview', true);
        try {
            app.activeDocument = copy;
            if (copy.mode !== DocumentMode.RGB) copy.changeMode(ChangeMode.RGB);
            if (copy.bitsPerChannel !== BitsPerChannelType.EIGHT) copy.bitsPerChannel = BitsPerChannelType.EIGHT;
            var w = px(copy.width), h = px(copy.height), edge = 1600;
            if (Math.max(w, h) > edge) {
                if (w >= h) copy.resizeImage(UnitValue(edge, 'px'), UnitValue(Math.round(h * edge / w), 'px'), null, ResampleMethod.BICUBIC);
                else copy.resizeImage(UnitValue(Math.round(w * edge / h), 'px'), UnitValue(edge, 'px'), null, ResampleMethod.BICUBIC);
            }
            var options = new PNGSaveOptions();
            options.compression = 6;
            copy.saveAs(new File(cfg.out_png), options, true, Extension.LOWERCASE);
        } finally {
            copy.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = active;
        }
        result.document = describe(doc);
    }

    // Agent 写的 ExtendScript 函数体（ADR-0043）。脚本里的 alert / confirm / prompt 不弹框（弹框会让调用挂住），
    // 执行出错不回滚，回执里带错误与行号以及执行后的文档状态。
    function runScript(cfg, result) {
        if (cfg.document_id) app.activeDocument = documentById(cfg.document_id);
        var host = $.global, saved = { alert: host.alert, confirm: host.confirm, prompt: host.prompt };
        host.alert = function (message) { $.writeln(String(message)); };
        host.confirm = function () { return true; };
        host.prompt = function (message, fallback) { return fallback; };
        try {
            var value = new Function('atelier', cfg.code)({ version: app.version });
            try { result.value = eval('(' + toJson(value === undefined ? null : value) + ')'); }
            catch (e) { result.value = String(value); }
        } finally {
            host.alert = saved.alert; host.confirm = saved.confirm; host.prompt = saved.prompt;
        }
    }

    var result = { ok: false, timings: {} }, cfg = null;
    var started = now();
    var previous = { dialogs: app.displayDialogs, ruler: app.preferences.rulerUnits };
    try {
        if (!args.length) throw new Error('MISSING_CONFIG_PATH');
        cfg = eval('(' + readText(String(args[0])) + ')');
        result.action = cfg.action;
        // 服务端超时后会写取消标记：PS 关掉对话框后迟到执行的这一次直接退出，不改文档（探针第 7 项）。
        if (cfg.cancel && new File(cfg.cancel).exists) throw new Error('CANCELLED');
        app.displayDialogs = DialogModes.NO;
        app.preferences.rulerUnits = Units.PIXELS;
        if (cfg.action === 'version') {
            result.version = app.version;
            result.active_document = app.documents.length ? app.activeDocument.name : null;
        } else if (cfg.action === 'inspect') inspect(result);
        else if (cfg.action === 'import') exportImage(cfg, result);
        else if (cfg.action === 'place') placeImage(cfg, result);
        else if (cfg.action === 'preview') previewDocument(cfg, result);
        else if (cfg.action === 'execute') {
            try { runScript(cfg, result); } finally { inspect(result); }
        } else throw new Error('UNKNOWN_ACTION');
        result.ok = true;
    } catch (e) {
        result.error = String(e);
        result.line = e.line;
    } finally {
        app.displayDialogs = previous.dialogs;
        app.preferences.rulerUnits = previous.ruler;
    }
    result.timings.total_ms = now() - started;
    var text = toJson(result);
    if (cfg && cfg.result) writeText(cfg.result, text);
    return text;
})(ATELIER_ARGS);
