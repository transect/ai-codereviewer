import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const OPENAI_ASSISTANT_ID: string = 'asst_9fxOXtnqzEBcYeiE6lparuFG';

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, issue } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  // console.log(JSON.parse(
  //   readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  // ));
  // console.log(process.env);
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: issue.number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: issue.number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const useAssistantAPI = true
      const prompt = createPrompt(file, chunk, prDetails, useAssistantAPI);
      const aiResponse = await getAIResponse(prompt, useAssistantAPI);
      console.log("aiResponse:", JSON.stringify(aiResponse))
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails, useAssistantAPI: Boolean): string {
  const path = require('path');
  const transectPrompt = useAssistantAPI ? '' : readFileSync(path.join(__dirname, 'transect_prompt.txt'), 'utf-8');
  const chatGPTPrompt = `${transectPrompt}

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
  console.log("chatGPTPrompt:", chatGPTPrompt);
  return chatGPTPrompt;
}

async function getAIResponse(prompt: string, useAssistantAPI: boolean): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {

  try {
    const content = useAssistantAPI ? await sendAssistantPrompt(prompt): await sendCompletionsPrompt(prompt);
    
    console.log("res:", JSON.parse(content));
    return JSON.parse(content).reviews;
  } catch (error) {
    console.error("Error analyzing the code:", error);
    return null;
  }
}

async function sendAssistantPrompt(prompt: string) {
  let assistantId = OPENAI_ASSISTANT_ID;
  console.log('Fetched Assistant with Id: ' + assistantId);

  const thread = await openai.beta.threads.create({
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  let threadId = thread.id;
  console.log('Created thread with Id: ' + threadId);

  const run = await openai.beta.threads.runs.createAndPoll(
    thread.id, {
    assistant_id: assistantId,
    // additional_instructions: 'Please address the user as Jane Doe. The user has a premium account.',
  });

  console.log('Run finished with status: ' + run.status);

  if (run.status == 'completed') {
    const messages = await openai.beta.threads.messages.list(thread.id);
    return messages.getPaginatedItems()[0]?.toString().trim() || "{}";
  } else {
    throw new Error('Assistant run failed');
  }
}

async function sendCompletionsPrompt(prompt: string) {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  const response = await openai.chat.completions.create({
    ...queryConfig,
    // return JSON if the model supports it:
    ...(OPENAI_API_MODEL.includes("gpt-4")
      ? { response_format: { type: "json_object" } }
      : {}),
    messages: [
      {
        role: "system",
        content: prompt,
      },
    ],
  });

  return response.choices[0].message?.content?.trim() || "{}";
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  // TODO: change event to "APPROVE" or "REJECT" based on comments amount?
  if (comments.length > 0) {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments,
      event: "COMMENT",
    });
  }
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const { comment } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );

  if (comment.body.includes("/ai-review")) {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  // } else if (eventData.action === "synchronize") {
  //   const newBaseSha = eventData.before;
  //   const newHeadSha = eventData.after;

  //   const response = await octokit.repos.compareCommits({
  //     headers: {
  //       accept: "application/vnd.github.v3.diff",
  //     },
  //     owner: prDetails.owner,
  //     repo: prDetails.repo,
  //     base: newBaseSha,
  //     head: newHeadSha,
  //   });

  //   diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    try {
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
    } catch (error) {
      let batches = Math.ceil(comments.length / 10);
      for (let i = 0; i <= batches; i++) {
        try {
          await createReviewComment(
            prDetails.owner,
            prDetails.repo,
            prDetails.pull_number,
            comments.slice(i * 10, i * 10 + 10)
          );
        } catch (error) {
          console.error("Error creating the comment:", error);
          if ((error as any).data) {
            console.log("Error data:", (error as any).data);
          }
        }
      }
    }
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
