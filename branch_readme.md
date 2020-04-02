# Readme

`connectToDeltaStreamWithRetry` in `odspDocumentService.ts` is really ugly before this branch.

I refactored it to use await and stop nesting try-catch, but it was a very error-prone refactor because the code is so repetitive with subtle differences (It replays the same code 4 times with slightly different args).

So a few things here:

- How can I verify the correctness here?
- Is there a better/safer way to stage the refactor to prove correctness?
- Is there a further refactor to consider that parametrizes the repeated code so it can be written once and invoked 4 times?
