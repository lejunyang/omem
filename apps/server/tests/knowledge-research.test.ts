import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { KnowledgeRepository } from '../src/knowledge/repository.js';
import { MaterialResearch } from '../src/knowledge/research.js';

it('uses a path as research scope without drowning a late function match in directory tokens', () => {
  const dir=mkdtempSync(join(tmpdir(),'research-search-')),store=new Store(dir);
  try {
    store.capture({source:'file',externalId:'apps/server/src/app.ts',title:'apps/server/src/app.ts',parts:[{type:'text',text:'// apps server src app.ts\n'.repeat(120)+'const hits = retrieval.searchSourcesAsync(query);\nreturn hits;'}],context:{filePath:'apps/server/src/app.ts'}});
    store.capture({source:'file',externalId:'other.ts',title:'other.ts',parts:[{type:'text',text:'searchSourcesAsync'}],context:{filePath:'other.ts'}});
    const research = new MaterialResearch(new KnowledgeRepository(store).materials(),{key:'guide:search',title:'Search',kind:'explanation',order:0,reader:'Contributor',goal:'Find the search route',scenario:'Search by words',questions:['Which route executes the query?'],entryPaths:[]});
    const hits=research.search('searchSourcesAsync apps/server/src/app.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({key:'file:apps/server/src/app.ts',matches:[{range:{start:118,end:122}}]});
    expect(research.offers.get('file:apps/server/src/app.ts')?.ranges).toEqual([{start:118,end:122}]);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

it('offers all selected subject matter regardless of directory names and uses no historical-keyword gate', () => {
  const dir=mkdtempSync(join(tmpdir(),'research-domains-')),store=new Store(dir);
  try {
    for (const path of ['docs/archive/listening.md', '.agents/reading.md', 'notes/cooking.md']) store.capture({source:'file',externalId:path,title:path,parts:[{type:'text',text:'短句跟读时先听重音，再录音比较。'}],context:{filePath:path}});
    const research = new MaterialResearch(new KnowledgeRepository(store).materials(),{key:'listening',title:'跟读',kind:'tutorial',order:0,reader:'英语学习者',goal:'听清短句重音',scenario:'练习录音',questions:['怎样比较重音？'],entryPaths:[]});
    expect(research.catalog()).toHaveLength(3);
    expect(research.search('短句 重音')).toHaveLength(3);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
