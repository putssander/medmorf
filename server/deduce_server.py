#!/usr/bin/env python3
"""
Deduce API Server for Medmorf
Provides de-identification services for Dutch medical text
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from deduce import Deduce
from deduce.person import Person
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)
CORS(app)  # Enable CORS for browser access

# Initialize Deduce
deduce = Deduce()
logger.info("Deduce initialized successfully")

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "healthy", "service": "deduce"})

@app.route('/deidentify', methods=['POST'])
def deidentify():
    """
    De-identify text using Deduce
    
    Expected JSON:
    {
        "text": "string or array of strings",
        "patient": {  # optional
            "first_names": ["Jan"],
            "initials": "J",
            "surname": "Jansen"
        }
    }
    """
    try:
        data = request.json
        
        if not data or 'text' not in data:
            return jsonify({"error": "Missing 'text' field"}), 400
        
        text_input = data['text']
        patient_data = data.get('patient')
        
        # Handle patient metadata if provided
        metadata = None
        if patient_data:
            patient = Person(
                first_names=patient_data.get('first_names'),
                initials=patient_data.get('initials'),
                surname=patient_data.get('surname')
            )
            metadata = {'patient': patient}
        
        # Handle single text or array of texts
        if isinstance(text_input, str):
            doc = deduce.deidentify(text_input, metadata=metadata)
            result = {
                "deidentified_text": doc.deidentified_text,
                "annotations": [
                    {
                        "text": ann.text,
                        "tag": ann.tag,
                        "start_char": ann.start_char,
                        "end_char": ann.end_char
                    }
                    for ann in doc.annotations
                ]
            }
        else:
            # Process array of texts
            results = []
            for text in text_input:
                if text and isinstance(text, str) and text.strip():
                    doc = deduce.deidentify(text, metadata=metadata)
                    results.append({
                        "original": text,
                        "deidentified": doc.deidentified_text,
                        "annotation_count": len(doc.annotations)
                    })
                else:
                    results.append({
                        "original": text,
                        "deidentified": text,
                        "annotation_count": 0
                    })
            
            result = {"results": results, "total": len(results)}
        
        return jsonify(result)
    
    except Exception as e:
        logger.error(f"Error in deidentify: {str(e)}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/annotate', methods=['POST'])
def annotate():
    """
    Annotate text without redaction (shows what would be detected)
    """
    try:
        data = request.json
        
        if not data or 'text' not in data:
            return jsonify({"error": "Missing 'text' field"}), 400
        
        text = data['text']
        patient_data = data.get('patient')
        
        metadata = None
        if patient_data:
            patient = Person(
                first_names=patient_data.get('first_names'),
                initials=patient_data.get('initials'),
                surname=patient_data.get('surname')
            )
            metadata = {'patient': patient}
        
        doc = deduce.deidentify(text, metadata=metadata)
        
        result = {
            "text": text,
            "annotations": [
                {
                    "text": ann.text,
                    "tag": ann.tag,
                    "start_char": ann.start_char,
                    "end_char": ann.end_char
                }
                for ann in sorted(doc.annotations, key=lambda a: a.start_char)
            ],
            "annotation_count": len(doc.annotations)
        }
        
        return jsonify(result)
    
    except Exception as e:
        logger.error(f"Error in annotate: {str(e)}", exc_info=True)
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print("=" * 60)
    print("Medmorf Deduce API Server")
    print("=" * 60)
    print("Starting server on http://localhost:5000")
    print("Health check: http://localhost:5000/health")
    print("Endpoints:")
    print("  POST /deidentify - De-identify text")
    print("  POST /annotate - Show annotations without redaction")
    print("=" * 60)
    
    app.run(host='0.0.0.0', port=5000, debug=False)
