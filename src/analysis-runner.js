function errorMetadata(analyzer, error) {
  return error.aiMetadata || analyzer.getMetadata();
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

module.exports = { runLessonAnalysis };
