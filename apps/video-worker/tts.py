import os
import subprocess


def generate_tts(text: str, voice: str, voices_dir: str, output_path: str) -> None:
    model_path = os.path.join(voices_dir, f"{voice}.onnx")
    subprocess.run(
        ["piper", "--model", model_path, "--output_file", output_path],
        input=text,
        text=True,
        capture_output=True,
        check=True,
    )
