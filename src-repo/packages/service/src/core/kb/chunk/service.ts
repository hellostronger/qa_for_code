/**
 * 知识库切片服务 — 将文档拆分为可检索的语义块
 */
import { EmbeddingProvider } from '../embedding/provider';
import { VectorStore } from '../vectorstore/base';
import { ChunkSplitter } from './splitter';

export interface ChunkData {
  id: string;
  kbId: string;
  fileId: string;
  content: string;
  vector: number[];
  tokens: number;
  metadata: Record<string, any>;
}

export class ChunkService {
  constructor(
    private embedder: EmbeddingProvider,
    private vectorStore: VectorStore,
  ) {}

  /**
   * 将文档内容切分 + 向量化 + 存储
   */
  async processDocument(
    kbId: string,
    fileId: string,
    content: string,
    chunkSize = 512,
    chunkOverlap = 64,
  ): Promise<ChunkData[]> {
    // 1. 文本切分
    const splitter = new ChunkSplitter({ size: chunkSize, overlap: chunkOverlap });
    const chunks = splitter.split(content);

    // 2. 批量向量化
    const texts = chunks.map((c) => c.content);
    const vectors = await this.embedder.embedBatch(texts);

    // 3. 构建 chunk 对象
    const chunkData: ChunkData[] = chunks.map((chunk, i) => ({
      id: `${kbId}_${fileId}_${i}`,
      kbId,
      fileId,
      content: chunk.content,
      vector: vectors[i],
      tokens: chunk.tokens,
      metadata: { position: i, totalChunks: chunks.length },
    }));

    // 4. 存入向量数据库
    await this.vectorStore.upsert(chunkData);

    return chunkData;
  }

  /**
   * RAG 检索 — 根据查询向量搜索最相关的切片
   */
  async searchRelevant(kbId: string, query: string, topK = 5): Promise<ChunkData[]> {
    const queryVector = await this.embedder.embed(query);
    return this.vectorStore.similaritySearch(kbId, queryVector, topK);
  }

  /**
   * 删除知识库所有切片
   */
  async deleteByKbId(kbId: string): Promise<void> {
    await this.vectorStore.deleteByFilter({ kbId });
  }
}
