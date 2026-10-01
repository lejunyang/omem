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
    store.capture({source:'file',externalId:'omem:apps/server/src/app.ts',title:'apps/server/src/app.ts',parts:[{type:'text',text:'// apps server src app.ts\n'.repeat(120)+'const hits = retrieval.searchSourcesAsync(query);\nreturn hits;'}],context:{filePath:'apps/server/src/app.ts'}});
    store.capture({source:'file',externalId:'omem:other.ts',title:'other.ts',parts:[{type:'text',text:'searchSourcesAsync'}],context:{filePath:'other.ts'}});
    const research = new MaterialResearch(new KnowledgeRepository(store).materials(),{key:'guide:search',title:'Search',kind:'explanation',order:0,reader:'Contributor',goal:'Find the search route',scenario:'Search by words',questions:['Which route executes the query?'],entryPaths:[]});
    const hits=research.search('searchSourcesAsync apps/server/src/app.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({key:'omem:apps/server/src/app.ts',matches:[{range:{start:118,end:122}}]});
    expect(research.offers.get('omem:apps/server/src/app.ts')?.ranges).toEqual([{start:118,end:122}]);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
