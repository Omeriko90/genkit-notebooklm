import axios from "axios";
import pdfParse from "pdf-parse";
import path from "path";
import mammoth from "mammoth"; // For .docx

/**
 * This function retrieves text content from a given URL. It supports regular URLs.
 *
 * 1. Fetches the file from the URL.
 *    - Converts the response to a buffer.
 *
 * 2. Determines the content type and file extension to decide how to process the file:
 *    - For PDF files (content type includes "pdf" or extension is ".pdf"):
 *      - Uses pdf-parse to extract text content from the PDF buffer.
 *    - For plain text files (content type includes "plain" or extension is ".txt"):
 *      - Converts the buffer to a UTF-8 string.
 *    - For Word documents (content type includes "word" or extension is ".docx"):
 *      - Uses mammoth to extract raw text from the Word document buffer.
 *    - For Markdown files (extension is ".md"):
 *      - Converts the buffer to a UTF-8 string.
 *
 * 3. Returns an object containing:
 *    - isText: A boolean indicating whether the file was successfully processed as text.
 *    - content: The extracted text content.
 *
 * If any errors occur during the process, they are logged and re-thrown.
 */
export async function getTextFromUrl(url: string): Promise<{ isText: boolean, content: string }> {
  try {
    let buffer: Buffer;
    let contentType = "";

    // Handle regular URL
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'Accept': '*/*'
      }
    });
    contentType = response.headers['content-type'] || "";
    buffer = Buffer.from(response.data);

    const extension = path.extname(url).toLowerCase();

    let text = "";
    let isText = false;

    if (contentType.includes("pdf") || extension === ".pdf") {
      const data = await pdfParse(buffer);
      text = data.text;
      isText = true;
    } else if (contentType.includes("plain") || extension === ".txt") {
      text = buffer.toString("utf-8");
      isText = true;
    } else if (contentType.includes("word") || extension === ".docx") {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      isText = true;
    } else if (extension === ".md") {
      text = buffer.toString("utf-8");
      isText = true;
    }

    return { isText, content: text };
  } catch (error) {
    console.error("Error processing file:", error);
    throw error;
  }
}

export function isUrl(text: string): boolean {
  const trimmed = text.trim();
  // Check for spaces
  if (trimmed.includes(' ')) {
    return false;
  }

  // Check for standard URLs
  try {
    new URL(trimmed);
    return true;
  } catch (_) {
    return false;
  }
}
