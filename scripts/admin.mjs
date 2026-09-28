// Manages the Lambda-hosted server's settings: the Google OAuth client, who can connect, and the
// token-signing secret. They're SecureString parameters in SSM Parameter Store, in the region of
// your default AWS profile (the one `sam deploy` uses). Lambda reads them once per cold start, so
// every change here also recycles the function's running instances.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  GetFunctionUrlConfigCommand,
  LambdaClient,
  ResourceNotFoundException,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";

const USAGE = `Usage: npm run admin -- <command>

  google-client [client_secret.json]
                        Set the Google OAuth client, from the JSON file downloaded from Google Cloud,
                        or by prompting for its client ID and secret
  allow <email>...      Let Google accounts connect
  deny <email>...       Stop Google accounts connecting (signs them out everywhere)
  list                  Show the Google OAuth client and who can connect
  sign-out-all          Replace the signing secret (everyone has to connect again)`;

const prefix = process.env.SSM_PREFIX ?? "/google-health-mcp";
const functionName = "google-health-mcp"; // FunctionName in template.yaml
const ssm = new SSMClient({});
const lambda = new LambdaClient({});
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function getParameter(name) {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: `${prefix}/${name}`, WithDecryption: true }));
    return result.Parameter.Value;
  } catch (error) {
    if (error instanceof ParameterNotFound) return undefined;
    throw error;
  }
}

async function putParameter(name, value) {
  await ssm.send(new PutParameterCommand({ Name: `${prefix}/${name}`, Value: value, Type: "SecureString", Overwrite: true }));
}

async function ensureSigningSecret() {
  if (!(await getParameter("MCP_SIGNING_SECRET"))) await putParameter("MCP_SIGNING_SECRET", randomBytes(32).toString("hex"));
}

async function loadEmails() {
  return JSON.parse((await getParameter("ALLOWED_EMAILS")) ?? "[]");
}

async function saveEmails(emails) {
  await ensureSigningSecret();
  // A JSON array, as SSM values can't be empty
  await putParameter("ALLOWED_EMAILS", JSON.stringify([...new Set(emails)].sort()));
}

function parseEmails(values) {
  if (values.length === 0) fail(`${command} needs at least one email address`);
  const emails = values.map((value) => value.trim().toLowerCase());
  const invalid = emails.filter((email) => !EMAIL.test(email));
  if (invalid.length > 0) fail(`Not valid email addresses: ${invalid.join(", ")}`);
  return emails;
}

// Any configuration change makes Lambda start fresh instances, which read the new values
async function recycleLambda() {
  try {
    await lambda.send(
      new UpdateFunctionConfigurationCommand({ FunctionName: functionName, Description: `Settings updated ${new Date().toISOString()}` })
    );
    console.log(`Recycled ${functionName} so it picks up the change.`);
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    console.log(`${functionName} isn't deployed yet; run npm run deploy next.`);
  }
}

// The redirect URI the Google OAuth client must allow, if the function is deployed
async function googleRedirectUri() {
  try {
    const { FunctionUrl } = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: functionName }));
    return `${FunctionUrl}oauth/callback`;
  } catch {
    return undefined;
  }
}

let readline, lines;
async function ask(question, { hidden = false } = {}) {
  if (!readline) {
    readline = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    lines = readline[Symbol.asyncIterator]();
  }
  readline.setPrompt(question);
  readline.prompt();
  const echo = readline._writeToOutput;
  // Don't echo what's typed (the client secret)
  if (hidden && process.stdin.isTTY) readline._writeToOutput = () => {};
  const { value = "" } = await lines.next();
  if (readline._writeToOutput !== echo) {
    readline._writeToOutput = echo;
    process.stdout.write("\n");
  }
  return value.trim();
}

if (!command) {
  console.log(USAGE);
  process.exit(0);
}
console.log(`Region: ${await ssm.config.region()}`);

switch (command) {
  case "google-client": {
    let clientId, clientSecret, redirectUris;
    if (args[0]) {
      // Google Cloud's download is {"web": {...}} for Web application clients
      const file = JSON.parse(readFileSync(args[0], "utf8"));
      if (!file.web) fail("That isn't a Web application client. Create the OAuth client with application type Web application.");
      ({ client_id: clientId, client_secret: clientSecret, redirect_uris: redirectUris } = file.web);
    } else {
      clientId = await ask("Google OAuth client ID: ");
      clientSecret = await ask("Google OAuth client secret: ", { hidden: true });
    }
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId ?? "")) fail(`That doesn't look like a Google OAuth client ID: ${clientId}`);
    if (!clientSecret) fail("The client secret is missing.");

    const previous = await getParameter("GOOGLE_CLIENT_ID");
    await putParameter("GOOGLE_CLIENT_ID", clientId);
    await putParameter("GOOGLE_CLIENT_SECRET", clientSecret);
    console.log(`Saved Google OAuth client ${clientId}.`);
    if (previous && previous !== clientId) {
      // Everyone's Google grants belong to the old client
      await putParameter("MCP_SIGNING_SECRET", randomBytes(32).toString("hex"));
      console.log("Replaced the signing secret: everyone has to connect again.");
    } else {
      await ensureSigningSecret();
    }

    const expected = await googleRedirectUri();
    if (expected && redirectUris && !redirectUris.includes(expected)) {
      console.log(`\nWarning: add ${expected} to the client's authorized redirect URIs in Google Cloud.`);
    } else if (expected && !redirectUris) {
      console.log(`\nThe client's authorized redirect URIs must include ${expected}`);
    }
    if (!(await getParameter("ALLOWED_EMAILS"))) console.log("\nNext, let yourself connect: npm run admin -- allow <your Google email>");
    await recycleLambda();
    break;
  }

  case "allow": {
    const added = parseEmails(args);
    const current = await loadEmails();
    await saveEmails([...current, ...added]);
    for (const email of added) console.log(current.includes(email) ? `${email} already can connect.` : `${email} can connect.`);
    await recycleLambda();
    break;
  }

  case "deny": {
    const removed = parseEmails(args);
    const current = await loadEmails();
    const unknown = removed.filter((email) => !current.includes(email));
    if (unknown.length > 0) fail(`Not on the allowlist: ${unknown.join(", ")}`);
    const remaining = current.filter((email) => !removed.includes(email));
    if (remaining.length === 0) fail("Can't remove the last email; the server needs at least one. Use sam delete to take it down.");
    await saveEmails(remaining);
    for (const email of removed) console.log(`${email} can no longer connect.`);
    await recycleLambda();
    break;
  }

  case "list": {
    const clientId = await getParameter("GOOGLE_CLIENT_ID");
    console.log(`Google OAuth client: ${clientId ?? "not set (npm run admin -- google-client)"}`);
    const expected = await googleRedirectUri();
    if (expected) console.log(`Redirect URI it must allow: ${expected}`);
    const emails = await loadEmails();
    console.log(emails.length > 0 ? `Can connect:\n${emails.map((e) => `  ${e}`).join("\n")}` : "Nobody can connect yet (npm run admin -- allow <email>)");
    break;
  }

  case "sign-out-all": {
    await putParameter("MCP_SIGNING_SECRET", randomBytes(32).toString("hex"));
    console.log("Replaced the signing secret: everyone has to connect again.");
    await recycleLambda();
    break;
  }

  default:
    console.log(USAGE);
    process.exitCode = 1;
}

readline?.close();
