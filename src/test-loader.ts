import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";

async function main() {
  const loader = new DocxLoader("./data/Arbetsmiljöpolicy.docx");
  const docs = await loader.load();
  console.log("docs count:", docs.length);
  console.log("first doc pageContent length:", docs[0]?.pageContent?.length);
  console.log("first 200 chars:", docs[0]?.pageContent?.slice(0, 200));
}

main().catch(console.error);
