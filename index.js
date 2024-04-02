const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');
const _ = require('lodash');
const readline = require('readline');

const ratingsFile = './data/light-ratings.csv';
const moviesFile = './data/movies.csv';
const dataFile = './data/u.data';

// ------------------ Data Loading ------------------
async function loadMovieLensData() {
    const ratings = await loadRatings(ratingsFile);
    const movies = await loadMovies(moviesFile);

    // Structure the data for easier use
    const ratingsData = formatRatingsData(ratings);

    return { ratingsData, movies };
}

function loadRatings(file) {
    return new Promise((resolve, reject) => {
        const data = [];
        fs.createReadStream(file)
            .pipe(csv({ separator: '\t' }))
            .on('data', (row) => {
                const [userId, movieId, rating] = [
                    parseInt(row['userId']),
                    parseInt(row['movieId']),
                    parseFloat(row['rating']),
                ];
                return userId && movieId && rating
                    ? data.push({ userId, movieId, rating })
                    : null;
            })
            .on('error', reject)
            .on('end', () => resolve(data));
    });
}

function loadMovies(file) {
    return new Promise((resolve, reject) => {
        const data = {};
        fs.createReadStream(file)
            .pipe(csv({ separator: ',' }))
            .on('data', (row) => {
                data[+row['movieId']] = {
                    title: row['title'],
                    genres: row['genres'],
                };
            })
            .on('error', reject)
            .on('end', () => resolve(data));
    });
}

function formatRatingsData(ratings) {
    const ratingsData = ratings.reduce((acc, rating) => {
        if (!acc[rating.userId]) {
            acc[+rating.userId] = [];
        }
        acc[+rating.userId].push({
            movieId: rating.movieId,
            rating: rating.rating,
        });
        return acc;
    }, {});
    return ratingsData;
}

// ------------------ Collaborative Filtering  ------------------
/**
 * Calculate the similarity between two users based on their ratings
 * Uses the Pearson Correlation Coefficient
 */
function calculateSimilarity(user1Ratings, user2Ratings) {
    // Calculate the average rating for each user
    const avg1 = _.meanBy(user1Ratings, (r) => r.rating);
    const avg2 = _.meanBy(user2Ratings, (r) => r.rating);

    // Initialize values for the numerator and denominators of the Pearson Correlation Coefficient
    let numerator = 0;
    let sum1 = 0;
    let sum2 = 0;

    // Find the common movies rated by both users
    const commonMovies = _.intersectionBy(
        user1Ratings,
        user2Ratings,
        'movieId'
    );

    // Calculate the numerator and denominators for the Pearson Correlation Coefficient
    commonMovies.forEach((movie) => {
        numerator += (movie.rating - avg1) * (movie.rating - avg2);
        sum1 += Math.pow(movie.rating - avg1, 2);
        sum2 += Math.pow(movie.rating - avg2, 2);
    });

    // If the denominator is 0, return 0 to avoid division by zero
    if (sum1 * sum2 === 0) return 0;

    // Return the Pearson Correlation Coefficient
    // This value ranges from -1 to 1
    return numerator / Math.sqrt(sum1 * sum2);
}

// Find the k nearest neighbors to the target user
function findNearestNeighbors(userId, ratingsData, k) {
    const similarities = [];

    Object.entries(ratingsData).forEach(([user2Id, ratings]) => {
        // Skip the target user
        if (user2Id !== userId) {
            // Calculate the similarity between the target user and the current user
            const similarity = calculateSimilarity(
                ratingsData[`${userId}`],
                ratings
            );
            // Store the similarity and the ratings of the current user
            similarities.push({ userId: user2Id, similarity, ratings });
        }
    });
    // Sort the neighbors by similarity and return the top k
    return similarities.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

// Predict the rating for a movie based on the ratings of the neighbors
function predictRating(movieId, neighbors) {
    // Initialize the weighted sum and similarity sum
    let weightedSum = 0;
    let similaritySum = 0;

    // Iterate over the neighbors
    neighbors.forEach((neighbor) => {
        // Find the rating of the neighbor for the target movie
        const neighborRating = neighbor.ratings.find(
            (r) => r.movieId === movieId
        );
        // If the neighbor has rated the movie, add the weighted rating to the sum
        if (neighborRating) {
            weightedSum += neighborRating.rating * neighbor.similarity;
            similaritySum += neighbor.similarity;
        }
    });

    // Return the predicted rating
    return similaritySum > 0 ? (weightedSum / similaritySum).toFixed(1) : 1;
}

// ------------------  Movie Selection & Rating  ------------------
function selectRandomMovies(movies, numMovies) {
    const shuffled = _.shuffle(Object.entries(movies));
    return shuffled.slice(0, numMovies);
}

async function getMovieRatings(moviesToDisplay) {
    const userRatings = [];

    // Replace this loop with your frontend display and rating collection mechanism
    for (const movie of moviesToDisplay) {
        const rating = await promptUserForRating(movie); // Replace with your user input method
        // let rating = 1;
        // if (movie[1].genres.includes('Comedy')) {
        //     rating += 2;
        // }

        // if (movie[1].genres.includes('Action')) {
        //     rating += 2;
        // }

        userRatings.push({
            movieId: +movie[0],
            rating,
            title: movie[1].title,
            genres: movie[1].genres,
        });
    }
    console.log('🚀 ~ getMovieRatings ~ userRatings:', userRatings);

    return userRatings;
}

function promptUserForRating(movie) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        const { title, genres } = movie[1];

        rl.question(
            `Please rate the movie "${title}" "${genres
                .split('|')
                .join(',')} from 1 to 5 stars: `,
            (rating) => {
                rl.close();
                resolve(rating);
            }
        );
    });
}

// ------------------  Main Function  ------------------
const app = express();
app.use(express.json());

app.get('/getRandomMovies', async (req, res) => {
    const numMovies = req.query.numMovies || 20; // Default to 20 if no parameter is provided
    const moviesToDisplay = selectRandomMovies(movies, numMovies);
    res.json(moviesToDisplay);
});

app.post('/postUserRatings', async (req, res) => {
    const userRatings = req.body;
    if (!userRatings.length) {
        return res.status(400).json({ error: 'No ratings provided' });
    }
    console.log('🚀 ~ app.post ~ userRatings:', userRatings);

    const newUserId = +_.maxBy(Object.keys(ratingsData), parseInt) + 1; // Simple ID generation
    ratingsData[newUserId] = userRatings;

    const neighbors = findNearestNeighbors(newUserId, ratingsData, k);

    const unratedMovies = Object.entries(movies)
        .filter(([key]) => !userRatings.some((r) => r.movieId === +key))
        .map(([key, value]) => ({
            movieId: +key,
            title: value.title,
            genres: value.genres,
        }));

    const predictedMovies = unratedMovies.map((movie) => ({
        movieId: movie.movieId,
        title: movie.title,
        genres: movie.genres,
        predictedRating: predictRating(movie.movieId, neighbors),
    }));

    const topRecommendations = predictedMovies
        .sort((a, b) => b.predictedRating - a.predictedRating)
        .slice(0, 10);

    res.json(topRecommendations);
});

app.get('/getUserRecommendations', async (req, res) => {
    const recommendations = await main();
    res.json(recommendations);
});

let movies;
let ratingsData;
const k = 10; // Number of neighbors

(async () => {
    console.log('Loading MovieLens data...');
    const loadedData = await loadMovieLensData();
    movies = loadedData.movies;
    ratingsData = loadedData.ratingsData;

    app.listen(3000, () => console.log('Server is running on port 3000'));
})();
