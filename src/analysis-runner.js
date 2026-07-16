function errorMetadata(analyzer, error) {
  return error.aiMetadata || analyzer.getMetadata?.() || {};
}

const PROFILE_BATCH_MAX_CHARS = 45_000;
const PROFILE_BATCH_MAX_TRANSCRIPTS = 6;
const PROFILE_TRANSCRIPT_PART_CHARS = 18_000;

function transcriptParts(transcripts, partSize = PROFILE_TRANSCRIPT_PART_CHARS) {
  return transcripts.flatMap((transcript) => {
    const text = String(transcript.text || "");
    if (text.length <= partSize) return [{ ...transcript, text }];
    const parts = [];
    for (let offset = 0; offset < text.length; offset += partSize) {
      parts.push({ ...transcript, text: text.slice(offset, offset + partSize) });
    }
    return parts;
  });
}

function profileBatches(transcripts, maxChars = PROFILE_BATCH_MAX_CHARS, maxCount = PROFILE_BATCH_MAX_TRANSCRIPTS) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const transcript of transcriptParts(transcripts)) {
    const length = transcript.text.length;
    if (batch.length && (batch.length >= maxCount || chars + length > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(transcript);
    chars += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function runLessonAnalysis({ analyzer, database, transcript, student, tutorId }) {
  try {
    const { analysis, metadata } = await analyzer.analyze({ transcript, student });
    await database.createAiAnalysisLog({
      transcriptId: transcript.id,
      studentId: student.id,
      tutorId,
      status: "succeeded",
      ...metadata,
    });
    return database.saveAnalysis(transcript.id, tutorId, analysis);
  } catch (error) {
    const metadata = errorMetadata(analyzer, error);
    try {
      await database.createAiAnalysisLog({
        transcriptId: transcript.id,
        studentId: student.id,
        tutorId,
        status: "failed",
        errorMessage: error.message,
        ...metadata,
      });
    } catch (logError) {
      console.error("Failed to save AI analysis log", logError);
    }
    throw error;
  }
}

async function runProfileAnalysis({ analyzer, database, transcripts, student, card, tutorId }) {
  const batches = profileBatches(transcripts);
  if (!batches.length) throw new Error("No transcripts to analyze");

  let accumulated = card;
  let missingFields = [];
  for (const batch of batches) {
    try {
      const { profile, metadata } = await analyzer.analyzeProfile({ student, card: accumulated, transcripts: batch });
      await database.createAiAnalysisLog({
        transcriptId: null,
        studentId: student.id,
        tutorId,
        status: "succeeded",
        ...metadata,
      });
      ({ missingFields = [], ...accumulated } = profile);
    } catch (error) {
      try {
        await database.createAiAnalysisLog({
          transcriptId: null,
          studentId: student.id,
          tutorId,
          status: "failed",
          errorMessage: error.message,
          ...errorMetadata(analyzer, error),
        });
      } catch (logError) {
        console.error("Failed to save deep profile analysis log", logError);
      }
      throw error;
    }
  }

  return database.createProfileDraft({
    studentId: student.id,
    tutorId,
    changes: accumulated,
    sourceTranscriptIds: [...new Set(transcripts.map((transcript) => transcript.id))],
    missingFields,
  });
}

module.exports = { runLessonAnalysis, runProfileAnalysis, profileBatches, transcriptParts };
