import type { ArticleMeta } from "./api";
export type TopicNode = { title: string; path: string[]; children: TopicNode[]; articles: ArticleMeta[]; count: number };
export const inTopic = (article: ArticleMeta, path: string[]) => path.every((part, i) => article.topicPath?.[i] === part);
export const articleOrder = (a: ArticleMeta, b: ArticleMeta) => (a.reading?.order ?? Infinity) - (b.reading?.order ?? Infinity) || a.title.localeCompare(b.title);
export function topicTree(articles: ArticleMeta[]): TopicNode {
  const root: TopicNode = { title: "知识库", path: [], children: [], articles: [], count: articles.length };
  for (const article of [...articles].sort(articleOrder)) {
    let node = root;
    for (const part of article.topicPath ?? []) {
      let child = node.children.find(n => n.title === part);
      if (!child) { child = { title: part, path: [...node.path, part], children: [], articles: [], count: 0 }; node.children.push(child); }
      child.count++; node = child;
    }
    node.articles.push(article);
  }
  return root;
}
