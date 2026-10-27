const preview = new URL(location.href).searchParams.get("preview") === "1";
await import(preview ? "./widget-preview.js" : "./widget.js");
