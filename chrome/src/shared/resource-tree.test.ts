import { describe, expect, it } from "vitest";
import type { IndexedResource, ResourceFrameNode, SourceMappedResource } from "./resource-search";
import { buildResourceTree } from "./resource-tree";

const frames: ResourceFrameNode[] = [
  {
    frameId: "main-frame",
    parentFrameId: null,
    url: "https://shop.example.com/enterprise/index",
    name: "",
    securityOrigin: "https://shop.example.com",
    children: [
      {
        frameId: "child-frame",
        parentFrameId: "main-frame",
        url: "https://lf3-ad-platform.byteadverts.com/frame.html",
        name: "",
        securityOrigin: "https://lf3-ad-platform.byteadverts.com",
        children: []
      }
    ]
  }
];

const resources: IndexedResource[] = [
  createResource({
    id: "main-js",
    frameId: "main-frame",
    url: "https://lf3-ad-platform.byteadverts.com/obj/ad-platform/aweme/merchant/enterprise/main/static/js/index.js",
    origin: "https://lf3-ad-platform.byteadverts.com",
    type: "script"
  }),
  createResource({
    id: "main-css",
    frameId: "main-frame",
    url: "https://lf3-ad-platform.byteadverts.com/obj/ad-platform/aweme/merchant/enterprise/main/static/css/index.css",
    origin: "https://lf3-ad-platform.byteadverts.com",
    type: "stylesheet"
  }),
  createResource({
    id: "image",
    frameId: "main-frame",
    url: "https://lf3-ad-platform.byteadverts.com/logo.png",
    origin: "https://lf3-ad-platform.byteadverts.com",
    type: "other",
    contentState: "skipped"
  }),
  createResource({
    id: "child-js",
    frameId: "child-frame",
    url: "https://lf3-ad-platform.byteadverts.com/frame.js",
    origin: "https://lf3-ad-platform.byteadverts.com",
    type: "script"
  })
];

const sourceMappedResources: SourceMappedResource[] = [
  {
    id: "source-1",
    generatedResourceId: "main-js",
    sourceMapUrl: "https://lf3-ad-platform.byteadverts.com/index.js.map",
    path: "src/pages/enterprise/App.ts",
    url: "https://lf3-ad-platform.byteadverts.com/src/pages/enterprise/App.ts",
    contentState: "loaded",
    content: "export const app = true;",
    ignored: false,
    error: ""
  },
  {
    id: "missing-source",
    generatedResourceId: "main-js",
    sourceMapUrl: "https://lf3-ad-platform.byteadverts.com/index.js.map",
    path: "src/pages/enterprise/Missing.ts",
    url: "https://lf3-ad-platform.byteadverts.com/src/pages/enterprise/Missing.ts",
    contentState: "missing",
    content: "",
    ignored: false,
    error: "missing"
  }
];

describe("buildResourceTree", () => {
  it("builds a sources-style frame/origin/path/file tree", () => {
    const tree = buildResourceTree({
      frames,
      resources,
      sourceMappedResources,
      showSkippedResources: false,
      skipChromeExtensionResources: true,
      skipAnonymousScripts: false
    });

    expect(tree.searchableCount).toBe(4);
    expect(tree.totalCount).toBe(5);
    expect(tree.root.children.map((node) => node.label)).toEqual(["Source Map 源文件", "top"]);

    const top = tree.root.children.find((node) => node.label === "top");
    const origin = top?.children.find((node) => node.label === "https://lf3-ad-platform.byteadverts.com");
    expect(origin?.children[0]).toMatchObject({
      type: "folder",
      label: "obj/ad-platform/aweme/merchant/enterprise/main/static"
    });
    expect(JSON.stringify(origin)).toContain("index.js");
    expect(JSON.stringify(origin)).toContain("index.css");
    expect(JSON.stringify(origin)).not.toContain("logo.png");

    const childFrame = top?.children.find((node) => node.title === "https://lf3-ad-platform.byteadverts.com/frame.html");
    expect(JSON.stringify(childFrame)).toContain("frame.js");
  });

  it("adds skipped resources only when requested", () => {
    expect(
      JSON.stringify(
        buildResourceTree({
          frames,
          resources,
          sourceMappedResources: [],
          showSkippedResources: false,
          skipChromeExtensionResources: true,
          skipAnonymousScripts: false
        }).root
      )
    ).not.toContain("logo.png");

    expect(
      JSON.stringify(
        buildResourceTree({
          frames,
          resources,
          sourceMappedResources: [],
          showSkippedResources: true,
          skipChromeExtensionResources: true,
          skipAnonymousScripts: false
        }).root
      )
    ).toContain("logo.png");
  });

  it("groups loaded source mapped resources under source map root", () => {
    const tree = buildResourceTree({
      frames: [],
      resources: [
        createResource({
          id: "main-js",
          frameId: "",
          url: "https://example.com/index.js",
          origin: "https://example.com",
          type: "script"
        })
      ],
      sourceMappedResources,
      showSkippedResources: false,
      skipChromeExtensionResources: true,
      skipAnonymousScripts: false
    });

    expect(JSON.stringify(tree.root)).toContain("Source Map 源文件");
    expect(JSON.stringify(tree.root)).toContain("App.ts");
    expect(JSON.stringify(tree.root)).not.toContain("Missing.ts");
  });

  it("filters chrome extension generated resources and their source mapped files", () => {
    const tree = buildResourceTree({
      frames: [],
      resources: [
        createResource({
          id: "extension-js",
          frameId: "",
          url: "chrome-extension://extension-id/assets/src/js/service/content.js",
          origin: "chrome-extension://extension-id",
          type: "script"
        }),
        createResource({
          id: "page-js",
          frameId: "",
          url: "https://example.com/assets/src/js/service/page.js",
          origin: "https://example.com",
          type: "script"
        })
      ],
      sourceMappedResources: [
        {
          id: "extension-source",
          generatedResourceId: "extension-js",
          sourceMapUrl: "chrome-extension://extension-id/assets/src/js/service/content.js.map",
          path: "assets/src/js/service/content.ts",
          url: "chrome-extension://extension-id/assets/src/js/service/content.ts",
          contentState: "loaded",
          content: "export const content = true;",
          ignored: false,
          error: ""
        },
        {
          id: "page-source",
          generatedResourceId: "page-js",
          sourceMapUrl: "https://example.com/page.js.map",
          path: "assets/src/js/service/page.ts",
          url: "https://example.com/assets/src/js/service/page.ts",
          contentState: "loaded",
          content: "export const page = true;",
          ignored: false,
          error: ""
        }
      ],
      showSkippedResources: true,
      skipChromeExtensionResources: true,
      skipAnonymousScripts: false
    });

    const serialized = JSON.stringify(tree.root);
    expect(serialized).not.toContain("chrome-extension://extension-id");
    expect(serialized).not.toContain("content.ts");
    expect(serialized).toContain("page.js");
    expect(serialized).toContain("page.ts");
  });

  it("keeps chrome extension resources when filtering is disabled", () => {
    const tree = buildResourceTree({
      frames: [],
      resources: [
        createResource({
          id: "extension-js",
          frameId: "",
          url: "chrome-extension://extension-id/assets/src/js/service/content.js",
          origin: "chrome-extension://extension-id",
          type: "script"
        })
      ],
      sourceMappedResources: [],
      showSkippedResources: true,
      skipChromeExtensionResources: false,
      skipAnonymousScripts: false
    });

    expect(JSON.stringify(tree.root)).toContain("chrome-extension://extension-id");
  });

  it("labels unframed resources as Top and compresses single-folder chains", () => {
    const tree = buildResourceTree({
      frames: [],
      resources: [
        createResource({
          id: "unframed-js",
          frameId: "",
          url: "https://example.com/assets/src/js/service/content_script.js",
          origin: "https://example.com",
          type: "script"
        })
      ],
      sourceMappedResources: [],
      showSkippedResources: false,
      skipChromeExtensionResources: true,
      skipAnonymousScripts: false
    });

    expect(tree.root.children[0]).toMatchObject({
      label: "Top"
    });
    expect(JSON.stringify(tree.root)).toContain("assets/src/js/service");
  });

  it("merges resources without frameId into the top frame when frames exist", () => {
    const tree = buildResourceTree({
      frames,
      resources: [
        createResource({
          id: "page-sdk",
          frameId: "main-frame",
          url: "https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/1.0.0.66/sdk-glue.js",
          origin: "https://lf-c-flwb.bytetos.com",
          type: "script",
          source: "page"
        }),
        createResource({
          id: "debugger-sdk",
          frameId: "",
          url: "https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/1.0.0.66/sdk-glue.js",
          origin: "https://lf-c-flwb.bytetos.com",
          type: "script",
          source: "debugger"
        })
      ],
      sourceMappedResources: [],
      showSkippedResources: false,
      skipChromeExtensionResources: true,
      skipAnonymousScripts: false
    });

    expect(tree.root.children.map((node) => node.label)).toEqual(["top"]);
    expect(JSON.stringify(tree.root)).not.toContain('"Top"');
    expect(countFileNodes(tree.root, "sdk-glue.js")).toBe(1);
  });

  it("hides literal null origins behind a no-origin group", () => {
    const tree = buildResourceTree({
      frames: [],
      resources: [
        createResource({
          id: "script:1206",
          frameId: "",
          url: "1206",
          origin: "null",
          type: "script",
          source: "debugger"
        })
      ],
      sourceMappedResources: [],
      showSkippedResources: false,
      skipChromeExtensionResources: true,
      skipAnonymousScripts: false
    });

    const serialized = JSON.stringify(tree.root);
    expect(serialized).toContain("(no origin)");
    expect(serialized).toContain("匿名脚本 #1206");
    expect(serialized).not.toContain('"null"');
  });

  it("filters anonymous debugger scripts when requested", () => {
    const tree = buildResourceTree({
      frames: [],
      resources: [
        createResource({
          id: "script:1206",
          frameId: "",
          url: "1206",
          origin: "null",
          type: "script",
          source: "debugger",
          content: "const anonymous = true;"
        }),
        createResource({
          id: "real-script",
          frameId: "",
          url: "https://example.com/app.js",
          origin: "https://example.com",
          type: "script",
          source: "debugger"
        })
      ],
      sourceMappedResources: [],
      showSkippedResources: false,
      skipChromeExtensionResources: true,
      skipAnonymousScripts: true
    });

    const serialized = JSON.stringify(tree.root);
    expect(serialized).not.toContain("匿名脚本 #1206");
    expect(serialized).toContain("app.js");
  });
});

function createResource(input: Partial<IndexedResource> & Pick<IndexedResource, "id" | "frameId" | "url" | "origin" | "type">): IndexedResource {
  return {
    source: "page",
    mimeType: "",
    contentState: "loaded",
    content: "",
    sourceMapUrl: "",
    generatedResourceId: null,
    ignored: false,
    error: "",
    ...input
  };
}

function countFileNodes(node: ReturnType<typeof buildResourceTree>["root"], label: string): number {
  const self = node.type === "file" && node.label === label ? 1 : 0;
  return self + node.children.reduce((total, child) => total + countFileNodes(child, label), 0);
}
