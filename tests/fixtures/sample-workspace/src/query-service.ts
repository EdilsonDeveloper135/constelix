import { ProjectGraph, type ProjectSummary } from "./contracts.js";

export function createGraph(project: ProjectSummary): ProjectGraph {
  return new ProjectGraph(project);
}

export function answerProjectQuestion(project: ProjectSummary): string {
  const graph = createGraph(project);
  return graph.describe();
}
