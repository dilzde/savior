// --- script.js ---

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        // Only apply to internal links starting with #
        if (this.getAttribute('href').length > 1) { 
            e.preventDefault();
            document.querySelector(this.getAttribute('href')).scrollIntoView({
                behavior: 'smooth'
            });
        }
    });
});

// new contact


document.addEventListener('DOMContentLoaded', function() {
        const form = document.getElementById('service-contact-form');
        const serviceSelect = document.getElementById('service');
        const subjectField = document.getElementById('subject-field');
        // 'confirmationMessage' is no longer used here as Formspree handles the confirmation page.
        
        // Listener to dynamically update the hidden subject field whenever the dropdown changes
        serviceSelect.addEventListener('change', function() {
            const serviceLabel = this.value || 'General Inquiry';
            subjectField.value = `[INQUIRY] ${serviceLabel}`;
        });

        // The entire event listener for 'submit' has been removed to allow the browser 
        // to submit the form directly to the Formspree action URL.
    });